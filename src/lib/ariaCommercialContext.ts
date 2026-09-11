import { supabase } from './supabase';
import type { AppointmentDraft } from '../drafts';
import type { CommercialInsight } from './commercialInsights';

const DAY = 86400000;

type HistoryRow = {
  service_date: string | null;
  description: string | null;
  operation_type: string | null;
  os_type: string | null;
};

type Signal = {
  key: string;
  label: string;
  current: RegExp;
  historical: RegExp;
  suggestion: string;
};

function fold(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const signals: Signal[] = [
  {
    key: 'engine_oil_leak',
    label: 'Motor / lubrificação',
    current: /(vaz|ping|escorr|melad|baband|perd).*oleo.*motor|oleo.*motor.*(vaz|ping|escorr|melad|baband|perd)/,
    historical: /(vaz|ping|escorr|melad|baband|perd).*oleo.*motor|oleo.*motor.*(vaz|ping|escorr|melad|baband|perd)|lubrifica|carter|retentor.*motor/,
    suggestion: 'Como existe repetição do mesmo tipo de ocorrência, vale levar o histórico anterior para a avaliação. Caso o diagnóstico atual indique intervenções parciais recorrentes no mesmo sistema, pode existir oportunidade de estruturar uma solução mais ampla em vez de tratar cada ocorrência isoladamente.',
  },
  {
    key: 'engine_smoke_consumption',
    label: 'Motor',
    current: /(fumac|fumaça|consumo.*oleo|consumo.*óleo|baixando oleo|baixando óleo|blow by|blow-by)/,
    historical: /(fumac|fumaça|consumo.*oleo|consumo.*óleo|blow by|blow-by|cabecote|cabeçote|turbo|injetor|lubrifica)/,
    suggestion: 'O histórico relacionado ao motor aumenta a relevância comercial deste atendimento. Se a avaliação técnica confirmar necessidade de intervenção maior, vale comparar uma solução estruturada de reparo/recondicionamento ou Reman com novas intervenções parciais.',
  },
  {
    key: 'undercarriage',
    label: 'Material Rodante',
    current: /(material rodante|esteira|rolete|sprocket|roda guia|corrente|sapata|tensor)/,
    historical: /(material rodante|esteira|rolete|sprocket|roda guia|corrente|sapata|tensor|regulagem.*esteira)/,
    suggestion: 'Há repetição de ocorrências ligadas ao material rodante. Vale verificar a última medição disponível e, se houver outros componentes próximos do limite, avaliar uma renovação planejada do conjunto em vez de novas trocas isoladas.',
  },
  {
    key: 'transmission',
    label: 'Transmissão',
    current: /(transmiss|patin|marcha|nao engata|não engata|tranco)/,
    historical: /(transmiss|patin|marcha|embreagem|conversor|limalha.*transmiss)/,
    suggestion: 'A ocorrência atual se repete no mesmo sistema. Caso a avaliação técnica confirme desgaste interno ou necessidade de reparo maior, vale considerar uma solução estruturada/recondicionamento e verificar disponibilidade de Reman.',
  },
  {
    key: 'hydraulics',
    label: 'Sistema Hidráulico',
    current: /(hidraul|bomba|cilindro|motor de giro|motor de translacao|motor de translação|valvula|válvula)/,
    historical: /(hidraul|bomba|cilindro|motor de giro|motor de translacao|motor de translação|valvula|válvula)/,
    suggestion: 'Existe recorrência no sistema hidráulico. Se o diagnóstico atual confirmar desgaste relacionado, vale avaliar se faz sentido uma abordagem por conjunto ou parada programada, em vez de continuar apenas com intervenções pontuais.',
  },
  {
    key: 'implements',
    label: 'Implementos / GET',
    current: /(cacamba|caçamba|dente|adaptador|rompedor|acoplador|implemento|engate rapido|engate rápido)/,
    historical: /(cacamba|caçamba|dente|adaptador|rompedor|acoplador|implemento|engate rapido|engate rápido)/,
    suggestion: 'O mesmo grupo de implementos/itens de desgaste aparece novamente no histórico. Pode existir oportunidade de avaliar uma solução mais adequada à aplicação ou um pacote de componentes, em vez de reposições isoladas recorrentes.',
  },
  {
    key: 'structure',
    label: 'Estrutura / Articulações',
    current: /(trinca|folga|pino|bucha|lanca|lança|braco|braço|articulacao|articulação)/,
    historical: /(trinca|folga|pino|bucha|lanca|lança|braco|braço|articulacao|articulação)/,
    suggestion: 'Há recorrência em estrutura/articulações. Se a avaliação técnica apontar desgaste distribuído, vale analisar uma recuperação mais ampla em parada programada em vez de novos reparos isolados.',
  },
];

function getSignal(text: string) {
  const normalized = fold(text);
  return signals.find((signal) => signal.current.test(normalized)) || null;
}

function hourmeterFromDraft(draft: AppointmentDraft) {
  const value = Number(draft.reported_hourmeter || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function buildRecurrenceCommercialInsight(draft: AppointmentDraft): Promise<CommercialInsight | null> {
  const serial = draft.equipment_serial.trim();
  const currentText = `${draft.service_reason || ''} ${draft.description || ''}`;
  const signal = getSignal(currentText);
  if (!serial || !signal || fold(draft.description).length < 4) return null;

  // ilike evita perder o histórico por diferença de maiúsculas/minúsculas na série.
  const { data, error } = await supabase
    .from('g4_history_app')
    .select('service_date,description,operation_type,os_type')
    .ilike('serial', serial)
    .order('service_date', { ascending: false })
    .limit(120);

  if (error) return null;

  const now = Date.now();
  const related = ((data || []) as HistoryRow[]).filter((row) => {
    const text = fold([row.description, row.operation_type, row.os_type].filter(Boolean).join(' '));
    return signal.historical.test(text);
  });

  const last6m = related.filter((row) => row.service_date && now - new Date(row.service_date).getTime() <= 183 * DAY);
  const last12m = related.filter((row) => row.service_date && now - new Date(row.service_date).getTime() <= 365 * DAY);
  const last24m = related.filter((row) => row.service_date && now - new Date(row.service_date).getTime() <= 730 * DAY);
  const hourmeter = hourmeterFromDraft(draft);

  // Silêncio por padrão. Um único atendimento atual não vira oportunidade comercial sozinho.
  // Mostra somente quando existe reincidência real do mesmo tema, ou reincidência + ciclo de vida relevante.
  const strongRecurrence = last6m.length >= 2 || last12m.length >= 3;
  const usefulRecurrence = last12m.length >= 1 && hourmeter >= 8000;
  const repeatedHistory = last24m.length >= 2;

  if (!strongRecurrence && !usefulRecurrence && !repeatedHistory) return null;

  let score = 8;
  if (last6m.length >= 2) score += 3;
  if (last12m.length >= 3) score += 2;
  if (hourmeter >= 10000) score += 2;
  if (hourmeter >= 15000) score += 2;

  const last = related.find((row) => row.service_date)?.service_date;
  const lastText = last ? ` A ocorrência relacionada mais recente foi em ${new Intl.DateTimeFormat('pt-BR').format(new Date(`${last}T12:00:00`))}.` : '';
  const hourText = hourmeter ? ` A máquina está com ${Math.round(hourmeter).toLocaleString('pt-BR')} h informadas.` : '';

  return {
    title: `Oportunidade identificada: ${signal.label}`,
    message: `A ArIA encontrou ${last12m.length || last24m.length} atendimento(s) anterior(es) relacionado(s ao mesmo tema desta ocorrência.${lastText}${hourText} ${signal.suggestion}`.replace('relacionado(s ao', 'relacionado(s) ao'),
    potential: score >= 12 ? 'Muito alto' : 'Alto',
    score,
    kind: `recurrence:${signal.key}`,
  };
}
