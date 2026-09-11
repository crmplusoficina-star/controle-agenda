import { supabase } from './supabase';
import type { MachineSummary } from '../types';
import type { AppointmentDraft } from '../drafts';

const DAY = 86400000;

export type CommercialInsight = {
  title: string;
  message: string;
  potential: 'Alto' | 'Muito alto' | 'Estratégico';
  score: number;
  kind: string;
};

type HistoryRow = {
  service_date: string | null;
  description: string | null;
  operation_type: string | null;
  os_type: string | null;
};

type Category =
  | 'undercarriage'
  | 'engine'
  | 'cooling'
  | 'transmission'
  | 'axle'
  | 'hydraulics'
  | 'implements'
  | 'structure'
  | 'hvac'
  | 'electrical'
  | 'other';

type CategoryStats = Record<Category, { total: number; last12m: number; last24m: number; examples: string[] }>;

function fold(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const terms: Record<Exclude<Category, 'other'>, RegExp> = {
  undercarriage: /(material rodante|sprocket|rolete|roda guia|corrente|elo|sapata|esteira|tensor|regulagem de esteira|ajuste de esteira)/,
  cooling: /(liquido de arrefecimento|arrefecimento|coolant|radiador|reservatorio|mangueira.*agua|vaz.*agua|vaz.*liquido|superaquec|aquecendo|fervendo|temperatura.*motor)/,
  engine: /(motor|cabecote|turbo|injetor|injecao|blow by|compressao|fumac|consumo de oleo|pressao de oleo|lubrifica|carter|barulho.*motor|ruido.*motor|motor.*barulho|motor.*ruido)/,
  transmission: /(transmiss|patin|embreagem|conversor|troca de marcha|marchas|nao engata|tranco|oleo de transmiss)/,
  axle: /(diferencial|eixo dianteiro|eixo traseiro|eixo motriz|redutor final|final drive|carda|cardan|cruzeta)/,
  hydraulics: /(hidraul|bomba principal|bomba hidraul|motor de giro|motor de translacao|valvula principal|cilindro|contaminacao do circuito)/,
  implements: /(cacamba|dente|dentes|adaptador|get\b|rompedor|acoplador|engate rapido|implemento|tesoura|garra)/,
  structure: /(trinca.*lanca|trinca.*braco|pino|bucha|articulacao|folga.*lanca|folga.*braco|estrutura)/,
  hvac: /(ar condicionado|ar-condicionado|climatiza|cabine.*nao gela|ar.*nao gela|ar.*parou de gelar|parou de gelar|sem gelar|nao esta gelando|nao gela|compressor.*ar|evaporador|condensador)/,
  electrical: /(bateria|alternador|motor de partida|nao pega|nao liga|painel apag|falha eletrica|chicote|fusivel)/,
};

const lowValueOnly = /(lampada|fusivel|aperto|limpeza|regulagem basica|sensor barato|filtro individual|parafuso|pequena vedacao)/;
const routineReason = /(ferias|folga|sem agenda|treinamento|deslocamento|entrega tecnica)/;

function classify(text: string): Category {
  const value = fold(text);
  for (const key of Object.keys(terms) as Array<Exclude<Category, 'other'>>) {
    if (terms[key].test(value)) return key;
  }
  return 'other';
}

function blankStats(): CategoryStats {
  return {
    undercarriage: { total: 0, last12m: 0, last24m: 0, examples: [] },
    engine: { total: 0, last12m: 0, last24m: 0, examples: [] },
    cooling: { total: 0, last12m: 0, last24m: 0, examples: [] },
    transmission: { total: 0, last12m: 0, last24m: 0, examples: [] },
    axle: { total: 0, last12m: 0, last24m: 0, examples: [] },
    hydraulics: { total: 0, last12m: 0, last24m: 0, examples: [] },
    implements: { total: 0, last12m: 0, last24m: 0, examples: [] },
    structure: { total: 0, last12m: 0, last24m: 0, examples: [] },
    hvac: { total: 0, last12m: 0, last24m: 0, examples: [] },
    electrical: { total: 0, last12m: 0, last24m: 0, examples: [] },
    other: { total: 0, last12m: 0, last24m: 0, examples: [] },
  };
}

function historyStats(rows: HistoryRow[]) {
  const stats = blankStats();
  const now = Date.now();
  for (const row of rows) {
    const text = [row.description, row.operation_type, row.os_type].filter(Boolean).join(' ');
    const category = classify(text);
    const bucket = stats[category];
    bucket.total += 1;
    const when = row.service_date ? new Date(row.service_date).getTime() : 0;
    if (when && now - when <= 365 * DAY) bucket.last12m += 1;
    if (when && now - when <= 730 * DAY) bucket.last24m += 1;
    if (text.trim() && bucket.examples.length < 4) bucket.examples.push(text.trim());
  }
  return stats;
}

function currentHourmeter(draft: AppointmentDraft, lastHourmeter: { hourmeter: number; reading_date: string } | null) {
  const typed = Number(draft.reported_hourmeter);
  if (draft.reported_hourmeter !== '' && Number.isFinite(typed) && typed > 0) return typed;
  return Number(lastHourmeter?.hourmeter || 0);
}

function candidate(title: string, message: string, potential: CommercialInsight['potential'], score: number, kind: string): CommercialInsight {
  return { title, message, potential, score, kind };
}

function buildCandidates(text: string, hourmeter: number, stats: CategoryStats, clientMachineCount: number) {
  const current = fold(text);
  const currentCategory = classify(current);
  const candidates: CommercialInsight[] = [];

  if (!current || routineReason.test(current)) return candidates;
  if (lowValueOnly.test(current) && hourmeter < 20000 && stats[currentCategory].last12m < 2) return candidates;

  const bigSystems24 = (['engine', 'cooling', 'transmission', 'axle', 'hydraulics', 'undercarriage', 'structure'] as Category[])
    .filter((key) => stats[key].last24m > 0).length;

  if (hourmeter >= 30000) {
    candidates.push(candidate(
      'Oportunidade identificada: Ciclo de vida do equipamento',
      `A máquina está com ${Math.round(hourmeter).toLocaleString('pt-BR')} h informadas. Independentemente da causa deste atendimento, vale aproveitar a visita para revisar o histórico global do equipamento e avaliar se existe oportunidade de reforma, grandes componentes, plano de serviços ou renovação.`,
      'Estratégico',
      14 + Math.min(4, bigSystems24),
      'lifecycle_extreme_hours',
    ));
  } else if (hourmeter >= 15000 && bigSystems24 >= 2) {
    candidates.push(candidate(
      'Oportunidade identificada: Ciclo de vida / Rebuild',
      `A máquina está com ${Math.round(hourmeter).toLocaleString('pt-BR')} h e possui histórico recente em ${bigSystems24} sistemas relevantes. Vale avaliar economicamente uma abordagem de ciclo de vida, em vez de tratar grandes intervenções sempre de forma isolada.`,
      'Estratégico',
      12 + bigSystems24,
      'rebuild',
    ));
  }

  if (currentCategory === 'engine') {
    const strong = /(barulho.*motor|ruido.*motor|motor.*barulho|motor.*ruido|fumac|consumo.*oleo|blow by|baixa compress|limalha|metal.*oleo|pressao.*oleo|falha grave.*motor)/.test(current);
    const score = (strong ? 5 : 0) + (hourmeter >= 12000 ? 3 : 0) + (stats.engine.last24m >= 2 ? 4 : stats.engine.last24m ? 2 : 0);
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Motor',
        `O relato atual está relacionado ao motor${hourmeter ? ` e a máquina possui ${Math.round(hourmeter).toLocaleString('pt-BR')} h informadas` : ''}${stats.engine.last24m ? `, com ${stats.engine.last24m} ocorrência(s) de motor nos últimos 24 meses` : ''}. Caso o diagnóstico confirme necessidade de intervenção maior, vale avaliar reparo estruturado ou Reman em vez de novas intervenções parciais.`,
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'engine',
      ));
    }
  }

  if (currentCategory === 'cooling') {
    const strong = /(vaz.*liquido|vaz.*agua|arrefecimento|superaquec|fervendo|temperatura.*motor)/.test(current);
    const score = (strong ? 4 : 0) + (hourmeter >= 12000 ? 2 : 0) + (stats.cooling.last24m >= 2 ? 4 : stats.cooling.last24m ? 2 : 0) + (stats.engine.last24m >= 2 ? 2 : 0);
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Arrefecimento / Motor',
        `O atendimento atual envolve o sistema de arrefecimento${stats.cooling.last24m ? ` e há ${stats.cooling.last24m} ocorrência(s) relacionadas nos últimos 24 meses` : ''}. Se a avaliação técnica apontar reincidência ou impacto maior no motor, pode existir oportunidade de uma solução mais ampla em vez de tratar somente o evento atual.`,
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'cooling',
      ));
    }
  }

  if (currentCategory === 'hvac') {
    const recurrence = stats.hvac.last24m;
    const score = (recurrence >= 3 ? 6 : recurrence >= 2 ? 4 : recurrence ? 2 : 0) + (clientMachineCount >= 5 ? 2 : 0);
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Climatização da frota',
        `A climatização voltou a aparecer no histórico desta máquina${recurrence ? ` (${recurrence} ocorrência(s) em 24 meses)` : ''}. Como há recorrência, pode valer estruturar uma abordagem preventiva/comercial de climatização em vez de tratar cada ocorrência de forma isolada.`,
        'Alto',
        score,
        'hvac_recurrence',
      ));
    }
  }

  if (currentCategory === 'undercarriage') {
    const repeated = stats.undercarriage.last12m;
    let score = (hourmeter >= 8000 ? 3 : 0) + (hourmeter >= 10000 ? 2 : 0) + (repeated >= 3 ? 5 : repeated >= 2 ? 3 : 0);
    if (/(esteira solt|regulagem.*esteira|corrente|sapata|roda guia|sprocket|rolete|material rodante)/.test(current)) score += 3;
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Material Rodante',
        `O atendimento atual e o contexto da máquina justificam avaliar o conjunto de material rodante${repeated ? `, com ${repeated} ocorrência(s) relacionadas nos últimos 12 meses` : ''}. Vale verificar a última medição e, se houver desgaste distribuído, considerar uma renovação planejada em vez de trocas isoladas.`,
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'undercarriage',
      ));
    }
  }

  if (currentCategory === 'transmission') {
    const strong = /(patin|limalha|metal|nao engata|tranco|falha persistente)/.test(current);
    const score = (strong ? 5 : 0) + (hourmeter >= 12000 ? 3 : 0) + (stats.transmission.last24m >= 2 ? 5 : stats.transmission.last24m ? 2 : 0);
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Transmissão',
        'Há contexto suficiente para acompanhar uma oportunidade de alto valor na transmissão. Se o diagnóstico confirmar desgaste interno, vale avaliar reparo estruturado/recondicionamento e disponibilidade de Reman.',
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'transmission',
      ));
    }
  }

  if (currentCategory === 'axle') {
    const score = (/(limalha|metal|ruido|diferencial|redutor final)/.test(current) ? 4 : 0) + (stats.axle.last24m >= 2 ? 5 : stats.axle.last24m ? 2 : 0) + (hourmeter >= 12000 ? 2 : 0);
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Eixo / Diferencial',
        'Se a avaliação técnica confirmar desgaste relevante, vale estruturar uma solução de conjunto em vez de sucessivas intervenções isoladas.',
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'axle',
      ));
    }
  }

  if (currentCategory === 'hydraulics') {
    const major = /(bomba|motor de giro|motor de translacao|contaminacao|cilindro)/.test(current);
    const score = (major ? 5 : 0) + (stats.hydraulics.last24m >= 3 ? 4 : stats.hydraulics.last24m >= 2 ? 2 : 0) + (hourmeter >= 12000 ? 2 : 0);
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Sistema Hidráulico',
        'Caso o diagnóstico confirme desgaste relevante, vale avaliar solução de conjunto, reparo/substituição ou Reman quando aplicável, em vez de continuar somente com intervenções pontuais.',
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'hydraulics',
      ));
    }
  }

  if (currentCategory === 'implements') {
    const score = (/(rocha|pedreira|mineracao|abrasiv|demolicao)/.test(current) ? 3 : 0) + (/(cacamba|dente|adaptador|rompedor|acoplador)/.test(current) ? 4 : 0) + (stats.implements.last12m >= 3 ? 4 : stats.implements.last12m >= 2 ? 2 : 0);
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Implementos / GET',
        'A combinação do atendimento atual com o histórico/aplicação pode justificar uma solução de implemento, GET ou pacote de desgaste mais adequado, em vez de reposições isoladas recorrentes.',
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'implements',
      ));
    }
  }

  if (currentCategory === 'structure') {
    const score = (/(trinca|folga)/.test(current) ? 5 : 0) + (stats.structure.last24m >= 2 ? 5 : stats.structure.last24m ? 2 : 0) + (hourmeter >= 12000 ? 2 : 0);
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Estrutura / Articulações',
        'Se a avaliação técnica apontar desgaste distribuído ou reincidência, vale analisar uma recuperação mais ampla em parada programada em vez de novos reparos isolados.',
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'structure',
      ));
    }
  }

  return candidates;
}

async function campaignCandidate(serial: string): Promise<CommercialInsight | null> {
  const { data, error } = await supabase.from('aria_campaign_targets').select('*').limit(300);
  if (error || !data?.length) return null;
  const key = fold(serial);
  const target = (data as any[]).find((row) => fold(row.equipment_serial || row.serial || row.machine_serial) === key);
  if (!target) return null;
  const status = fold(target.status || target.execution_status);
  if (/(executad|concluid|nao aplicavel)/.test(status)) return null;
  const name = target.campaign_name || target.title || target.name || target.campaign_code || 'campanha cadastrada';
  return candidate(
    'Oportunidade identificada: Campanha / Recall',
    `A série ${serial} está vinculada a ${name} e não consta como executada. Como já existe atendimento programado, vale verificar a possibilidade de tratar a campanha na mesma visita.`,
    'Muito alto',
    20,
    'campaign',
  );
}

export async function buildCommercialInsight(
  draft: AppointmentDraft,
  machineContext: MachineSummary | null,
  lastHourmeter: { hourmeter: number; reading_date: string } | null,
): Promise<CommercialInsight | null> {
  const serial = draft.equipment_serial.trim();
  if (!serial) return null;

  const [campaign, historyResult, clientResult] = await Promise.all([
    campaignCandidate(serial),
    supabase
      .from('g4_history_app')
      .select('service_date,description,operation_type,os_type')
      .ilike('serial', serial)
      .order('service_date', { ascending: false })
      .limit(120),
    draft.client_name.trim()
      ? supabase.from('g4_client_summary').select('machine_count').ilike('client_name', `%${draft.client_name.trim()}%`).order('machine_count', { ascending: false }).limit(1)
      : Promise.resolve({ data: [], error: null } as any),
  ]);

  if (campaign) return campaign;

  const rows = (historyResult.data || []) as HistoryRow[];
  const stats = historyStats(rows);
  const hourmeter = currentHourmeter(draft, lastHourmeter);
  const currentText = [draft.service_reason, draft.description].filter(Boolean).join(' ');
  if (!fold(currentText)) return null;

  const clientMachineCount = Number((clientResult.data || [])[0]?.machine_count || 0);
  const candidates = buildCandidates(currentText, hourmeter, stats, clientMachineCount).sort((a, b) => b.score - a.score);
  const best = candidates[0] || null;
  if (!best || best.score < 8) return null;
  return best;
}
