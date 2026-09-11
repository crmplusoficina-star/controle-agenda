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
    current: /(fumac|consumo.*oleo|baixando oleo|blow by)/,
    historical: /(fumac|consumo.*oleo|blow by|cabecote|turbo|injetor|lubrifica)/,
    suggestion: 'O histórico relacionado ao motor aumenta a relevância comercial deste atendimento. Se a avaliação técnica confirmar necessidade de intervenção maior, vale comparar uma solução estruturada de reparo/recondicionamento ou Reman com novas intervenções parciais.',
  },
  {
    key: 'hvac',
    label: 'Climatização / cabine',
    current: /(ar condicionado|a c|ar ).*(nao gela|nao esta gelando|parou de gelar|sem gelar|gelando pouco|fraco|quente)|(?:nao gela|parou de gelar|sem gelar).*(ar condicionado|a c|ar)/,
    historical: /(ar condicionado|a c|climatiza|compressor.*ar|condensador|evaporador|nao gela|parou de gelar|sem gelar|gelando pouco)/,
    suggestion: 'Se o histórico mostrar repetição de atendimentos no sistema de climatização, pode valer uma abordagem mais completa de cabine/climatização em vez de novas intervenções isoladas. Sem reincidência, este atendimento sozinho não deve virar oportunidade comercial.',
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
    current: /(transmiss|patin|marcha|nao engata|tranco)/,
    historical: /(transmiss|patin|marcha|embreagem|conversor|limalha.*transmiss)/,
    suggestion: 'A ocorrência atual se repete no mesmo sistema. Caso a avaliação técnica confirme desgaste interno ou necessidade de reparo maior, vale considerar uma solução estruturada/recondicionamento e verificar disponibilidade de Reman.',
  },
  {
    key: 'hydraulics',
    label: 'Sistema Hidráulico',
    current: /(hidraul|bomba|cilindro|motor de giro|motor de translacao|valvula)/,
    historical: /(hidraul|bomba|cilindro|motor de giro|motor de translacao|valvula)/,
    suggestion: 'Existe recorrência no sistema hidráulico. Se o diagnóstico atual confirmar desgaste relacionado, vale avaliar se faz sentido uma abordagem por conjunto ou parada programada, em vez de continuar apenas com intervenções pontuais.',
  },
  {
    key: 'implements',
    label: 'Implementos / GET',
    current: /(cacamba|dente|adaptador|rompedor|acoplador|implemento|engate rapido)/,
    historical: /(cacamba|dente|adaptador|rompedor|acoplador|implemento|engate rapido)/,
    suggestion: 'O mesmo grupo de implementos/itens de desgaste aparece novamente no histórico. Pode existir oportunidade de avaliar uma solução mais adequada à aplicação ou um pacote de componentes, em vez de reposições isoladas recorrentes.',
  },
  {
    key: 'structure',
    label: 'Estrutura / Articulações',
    current: /(trinca|folga|pino|bucha|lanca|braco|articulacao)/,
    historical: /(trinca|folga|pino|bucha|lanca|braco|articulacao)/,
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

function countMajorSystems(rows: HistoryRow[]) {
  const found = new Set<string>();
  for (const row of rows) {
    const text = fold([row.description, row.operation_type, row.os_type].filter(Boolean).join(' '));
    if (/(motor|cabecote|turbo|injetor|lubrifica|fumac)/.test(text)) found.add('engine');
    if (/(transmiss|patin|embreagem|conversor)/.test(text)) found.add('transmission');
    if (/(diferencial|eixo|redutor final|cardan)/.test(text)) found.add('axle');
    if (/(hidraul|bomba|cilindro|motor de giro|motor de translacao|valvula)/.test(text)) found.add('hydraulics');
    if (/(material rodante|esteira|rolete|sprocket|roda guia|corrente|sapata)/.test(text)) found.add('undercarriage');
    if (/(trinca|folga|pino|bucha|lanca|braco|articulacao|estrutura)/.test(text)) found.add('structure');
  }
  return found.size;
}

export async function buildRecurrenceCommercialInsight(draft: AppointmentDraft): Promise<CommercialInsight | null> {
  const serial = draft.equipment_serial.trim();
  const currentText = `${draft.service_reason || ''} ${draft.description || ''}`;
  const signal = getSignal(currentText);
  const hourmeter = hourmeterFromDraft(draft);

  if (!serial || fold(draft.description).length < 4) return null;

  const { data, error } = await supabase
    .from('g4_history_app')
    .select('service_date,description,operation_type,os_type')
    .ilike('serial', serial)
    .order('service_date', { ascending: false })
    .limit(120);

  if (error) return null;

  const rows = (data || []) as HistoryRow[];
  const now = Date.now();
  const recent24 = rows.filter((row) => row.service_date && now - new Date(row.service_date).getTime() <= 730 * DAY);
  const majorSystems24 = countMajorSystems(recent24);

  // Correção de lógica: horímetro muito elevado não pode ser ignorado só porque a descrição atual
  // não pertence às categorias de alto valor. Ainda assim, evitamos alertar por horímetro sozinho:
  // exigimos histórico operacional suficiente para tornar a conversa de ciclo de vida útil.
  if (hourmeter >= 30000 && rows.length >= 5) {
    return {
      title: 'Oportunidade identificada: Ciclo de vida do equipamento',
      message: `A máquina está com ${Math.round(hourmeter).toLocaleString('pt-BR')} h informadas e possui histórico de atendimentos suficiente para justificar uma conversa de ciclo de vida. Este atendimento pode ser uma oportunidade para avaliar economicamente continuar reparando, reformar ou planejar renovação — sem relação direta com o diagnóstico atual.`,
      potential: 'Estratégico',
      score: 16 + Math.min(4, majorSystems24),
      kind: 'lifecycle:extreme_hourmeter',
    };
  }

  if (!signal) return null;

  const related = rows.filter((row) => {
    const text = fold([row.description, row.operation_type, row.os_type].filter(Boolean).join(' '));
    return signal.historical.test(text);
  });

  const last6m = related.filter((row) => row.service_date && now - new Date(row.service_date).getTime() <= 183 * DAY);
  const last12m = related.filter((row) => row.service_date && now - new Date(row.service_date).getTime() <= 365 * DAY);
  const last24m = related.filter((row) => row.service_date && now - new Date(row.service_date).getTime() <= 730 * DAY);

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
    message: `A ArIA encontrou ${last12m.length || last24m.length} atendimento(s) anterior(es) relacionado(s) ao mesmo tema desta ocorrência.${lastText}${hourText} ${signal.suggestion}`,
    potential: score >= 12 ? 'Muito alto' : 'Alto',
    score,
    kind: `recurrence:${signal.key}`,
  };
}
