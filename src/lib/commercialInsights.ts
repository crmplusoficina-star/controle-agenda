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

type Category = 'undercarriage' | 'engine' | 'transmission' | 'axle' | 'hydraulics' | 'implements' | 'structure' | 'other';

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
  undercarriage: /(material rodante|sprocket|rolete|roda guia|roda-guia|corrente|elo|sapata|esteira|tensor|regulagem de esteira|ajuste de esteira)/,
  engine: /(motor|cabecote|cabeçote|turbo|injetor|injecao|injecão|blow by|blow-by|compressao|compressão|fumac|consumo de oleo|consumo óleo|pressao de oleo|pressão de óleo|lubrifica|superaquec|limalha.*motor|metais.*oleo)/,
  transmission: /(transmiss|patin|embreagem|conversor|troca de marcha|marchas|limalha.*transmiss|oleo de transmiss|óleo de transmiss)/,
  axle: /(diferencial|eixo dianteiro|eixo traseiro|eixo motriz|redutor final|final drive|carda|cardan|cruzeta)/,
  hydraulics: /(hidraul|bomba principal|bomba hidraul|motor de giro|motor de translacao|motor de translação|valvula principal|válvula principal|cilindro|contaminacao do circuito|contaminação do circuito)/,
  implements: /(cacamba|caçamba|dente|dentes|adaptador|get\b|rompedor|acoplador|engate rapido|engate rápido|implemento|tesoura|garra)/,
  structure: /(trinca.*lanca|trinca.*lança|trinca.*braco|trinca.*braço|pino|bucha|articulacao|articulação|folga.*lanca|folga.*lança|folga.*braco|folga.*braço|estrutura)/,
};

const lowValueOnly = /(lampada|lâmpada|fusivel|fusível|chicote|aperto|limpeza|regulagem basica|regulagem básica|sensor|filtro|parafuso|vedacao|vedação|mangueira)/;
const highValueSignal = /(material rodante|motor|transmiss|diferencial|eixo|bomba hidraul|bomba hidrául|motor hidraul|motor hidrául|cilindro|cacamba|caçamba|rompedor|acoplador|estrutura|lanca|lança|braco|braço|rebuild|reman|recondicion|reforma)/;

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
    transmission: { total: 0, last12m: 0, last24m: 0, examples: [] },
    axle: { total: 0, last12m: 0, last24m: 0, examples: [] },
    hydraulics: { total: 0, last12m: 0, last24m: 0, examples: [] },
    implements: { total: 0, last12m: 0, last24m: 0, examples: [] },
    structure: { total: 0, last12m: 0, last24m: 0, examples: [] },
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
    if (text.trim() && bucket.examples.length < 3) bucket.examples.push(text.trim());
  }
  return stats;
}

function currentHourmeter(draft: AppointmentDraft, lastHourmeter: { hourmeter: number; reading_date: string } | null) {
  const typed = Number(draft.reported_hourmeter);
  if (draft.reported_hourmeter !== '' && Number.isFinite(typed) && typed > 0) return typed;
  return Number(lastHourmeter?.hourmeter || 0);
}

function hasAny(text: string, pattern: RegExp) {
  return pattern.test(fold(text));
}

function candidate(title: string, message: string, potential: CommercialInsight['potential'], score: number, kind: string): CommercialInsight {
  return { title, message, potential, score, kind };
}

function opportunityCandidates(text: string, hourmeter: number, stats: CategoryStats, clientMachineCount: number) {
  const current = fold(text);
  const currentCategory = classify(current);
  const candidates: CommercialInsight[] = [];

  const lowOnly = lowValueOnly.test(current) && !highValueSignal.test(current);
  if (lowOnly && stats[currentCategory].last12m < 3) return candidates;

  const bigSystems24 = (['engine', 'transmission', 'axle', 'hydraulics', 'undercarriage', 'structure'] as Category[])
    .filter((key) => stats[key].last24m > 0).length;

  if (hourmeter >= 15000 && bigSystems24 >= 3) {
    candidates.push(candidate(
      'Oportunidade identificada: Rebuild / renovação',
      `A máquina está com ${Math.round(hourmeter).toLocaleString('pt-BR')} h e possui histórico recente em ${bigSystems24} sistemas de alto valor. Vale avaliar economicamente uma reforma ampla ou renovação, em vez de tratar cada grande intervenção isoladamente.`,
      'Estratégico',
      14 + bigSystems24,
      'rebuild',
    ));
  }

  if (currentCategory === 'undercarriage') {
    const repeated = stats.undercarriage.last12m;
    const mentionsSprocket = hasAny(current, /sprocket/) || stats.undercarriage.examples.some((x) => hasAny(x, /sprocket/));
    const mentionsRoller = hasAny(current, /rolete/) || stats.undercarriage.examples.some((x) => hasAny(x, /rolete/));
    const trackIssue = hasAny(current, /(esteira solt|regulagem.*esteira|corrente|sapata|roda guia|material rodante)/);
    let score = 0;
    if (hourmeter >= 8000) score += 3;
    if (hourmeter >= 10000) score += 2;
    if (repeated >= 3) score += 5;
    else if (repeated >= 2) score += 3;
    if ((mentionsSprocket && mentionsRoller) || trackIssue) score += 3;
    if (score >= 7) {
      candidates.push(candidate(
        'Oportunidade identificada: Material Rodante',
        `Há sinais suficientes para uma avaliação comercial do conjunto: ${repeated ? `${repeated} ocorrência(s) relacionada(s) nos últimos 12 meses` : 'atendimento atual relacionado'}${hourmeter ? ` e ${Math.round(hourmeter).toLocaleString('pt-BR')} h registradas` : ''}. Vale verificar a última medição; se outros componentes estiverem próximos do limite, pode fazer sentido cotar uma renovação parcial ou completa em vez de novas intervenções isoladas.`,
        score >= 10 ? 'Muito alto' : 'Alto',
        score,
        'undercarriage',
      ));
    }
  }

  if (currentCategory === 'engine') {
    const strong = hasAny(current, /(fumac|consumo.*oleo|consumo.*óleo|blow by|blow-by|baixa compress|compressao.*baixa|compressão.*baixa|limalha|metais.*oleo|pressao.*oleo|pressão.*óleo|falha grave.*motor)/);
    const previousMajor = stats.engine.last24m >= 2;
    let score = 0;
    if (strong) score += 4;
    if (hourmeter >= 12000) score += 3;
    if (hourmeter >= 15000) score += 2;
    if (previousMajor) score += 4;
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Motor',
        `O atendimento atual está relacionado ao motor${hourmeter ? ` em uma máquina com ${Math.round(hourmeter).toLocaleString('pt-BR')} h` : ''}${previousMajor ? `, com ${stats.engine.last24m} ocorrência(s) relacionadas nos últimos 24 meses` : ''}. Caso o diagnóstico confirme desgaste interno ou necessidade de reparo maior, vale comparar reparo completo e solução Reman em vez de mais uma intervenção parcial.`,
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'engine',
      ));
    }
  }

  if (currentCategory === 'transmission') {
    const strong = hasAny(current, /(patin|limalha|metais|falha persistente|nao engata|não engata|tranco)/);
    let score = (strong ? 5 : 0) + (hourmeter >= 12000 ? 3 : 0) + (stats.transmission.last24m >= 2 ? 5 : stats.transmission.last24m ? 2 : 0);
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Transmissão',
        `Existe contexto suficiente para acompanhar uma oportunidade de alto valor na transmissão${stats.transmission.last24m ? `, com ${stats.transmission.last24m} ocorrência(s) relacionadas nos últimos 24 meses` : ''}. Se o diagnóstico confirmar desgaste interno, vale avaliar reparo estruturado/recondicionamento e disponibilidade de Reman.`,
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'transmission',
      ));
    }
  }

  if (currentCategory === 'axle') {
    const strong = hasAny(current, /(limalha|metal|ruido recorrente|ruído recorrente|temperatura.*eixo|diferencial|redutor final)/);
    let score = (strong ? 4 : 0) + (stats.axle.last24m >= 2 ? 5 : stats.axle.last24m ? 2 : 0) + (hourmeter >= 12000 ? 2 : 0);
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Eixo / Diferencial',
        `O atendimento e o histórico apontam recorrência ou desgaste relevante no conjunto${stats.axle.last24m ? ` (${stats.axle.last24m} ocorrência(s) em 24 meses)` : ''}. Se a avaliação técnica confirmar dano interno, vale estruturar uma solução de conjunto em vez de sucessivas intervenções isoladas.`,
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'axle',
      ));
    }
  }

  if (currentCategory === 'hydraulics') {
    const pump = hasAny(current, /(bomba hidraul|bomba principal|baixa eficiencia|baixa eficiência|contaminacao|contaminação)/);
    const travelSwing = hasAny(current, /(motor de giro|motor de translacao|motor de translação)/);
    const cylinders = hasAny(current, /cilindro/) && stats.hydraulics.last24m >= 2;
    let score = (pump ? 5 : 0) + (travelSwing ? 4 : 0) + (cylinders ? 4 : 0) + (stats.hydraulics.last24m >= 3 ? 4 : stats.hydraulics.last24m >= 2 ? 2 : 0) + (hourmeter >= 12000 ? 2 : 0);
    if (score >= 8) {
      const focus = pump ? 'bomba/circuito hidráulico' : travelSwing ? 'motor hidráulico' : cylinders ? 'conjunto de cilindros' : 'sistema hidráulico';
      candidates.push(candidate(
        'Oportunidade identificada: Sistema Hidráulico',
        `Há contexto para avaliar uma oportunidade no ${focus}${stats.hydraulics.last24m ? ` e ${stats.hydraulics.last24m} ocorrência(s) hidráulica(s) nos últimos 24 meses` : ''}. Caso o diagnóstico confirme desgaste relevante, vale avaliar solução de conjunto, reparo/substituição ou Reman quando aplicável.`,
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'hydraulics',
      ));
    }
  }

  if (currentCategory === 'implements') {
    const rock = hasAny(current, /(rocha|pedreira|mineracao|mineração|abrasiv|demolicao|demolição)/);
    const bucket = hasAny(current, /(cacamba|caçamba)/);
    const get = hasAny(current, /(dente|dentes|adaptador|get\b)/);
    const quickCoupler = hasAny(current, /(troca.*implemento|varios implementos|vários implementos|acoplamento manual)/);
    const breaker = hasAny(current, /(rompedor|demolicao|demolição)/);
    let score = (rock ? 3 : 0) + (bucket ? 3 : 0) + (get ? 3 : 0) + (quickCoupler ? 5 : 0) + (breaker ? 4 : 0) + (stats.implements.last12m >= 3 ? 4 : stats.implements.last12m >= 2 ? 2 : 0);
    if (score >= 8) {
      const focus = quickCoupler ? 'acoplamento rápido' : breaker ? 'implemento adequado à aplicação' : bucket ? 'caçamba/GET e proteção de desgaste' : 'implementos';
      candidates.push(candidate(
        'Oportunidade identificada: Implementos',
        `A combinação do atendimento atual com o histórico/aplicação justifica avaliar ${focus}. A sugestão é comercial e deve ser confirmada conforme aplicação real, condição do equipamento e diagnóstico do atendimento.`,
        score >= 11 ? 'Muito alto' : 'Alto',
        score,
        'implements',
      ));
    }
  }

  if (currentCategory === 'structure') {
    const repeatedCrack = hasAny(current, /(trinca|folga)/) && stats.structure.last24m >= 2;
    let score = (repeatedCrack ? 6 : 0) + (hourmeter >= 12000 ? 2 : 0) + (stats.structure.last24m >= 3 ? 3 : 0);
    if (score >= 8) {
      candidates.push(candidate(
        'Oportunidade identificada: Estrutura / Articulações',
        `Há reincidência suficiente para avaliar uma recuperação mais ampla de estrutura/articulações em parada programada, em vez de continuar somente com reparos pontuais. A extensão deve ser definida pela avaliação técnica.`,
        score >= 10 ? 'Muito alto' : 'Alto',
        score,
        'structure',
      ));
    }
  }

  const relatedCorrectives12 = (Object.keys(stats) as Category[]).reduce((sum, key) => sum + (key === 'other' ? 0 : stats[key].last12m), 0);
  if (clientMachineCount >= 5 && relatedCorrectives12 >= 3) {
    candidates.push(candidate(
      'Oportunidade identificada: Plano de Serviços',
      `O cliente possui ${clientMachineCount} máquinas no histórico e esta máquina participa de um padrão de corretivas relevantes (${relatedCorrectives12} ocorrência(s) em 12 meses). Pode valer avaliar uma abordagem de manutenção estruturada para a frota, em vez de negociações unitárias recorrentes.`,
      clientMachineCount >= 8 ? 'Muito alto' : 'Alto',
      8 + Math.min(4, clientMachineCount / 2),
      'service_plan',
    ));
  }

  return candidates;
}

async function campaignCandidate(serial: string): Promise<CommercialInsight | null> {
  // Suporte opcional: se a operação criar uma tabela aria_campaign_targets, a ArIA passa a usá-la
  // sem tornar campanha/recall obrigatório para o restante do motor de insights.
  const { data, error } = await supabase.from('aria_campaign_targets').select('*').limit(300);
  if (error || !data?.length) return null;
  const key = fold(serial);
  const target = (data as any[]).find((row) => fold(row.equipment_serial || row.serial || row.machine_serial) === key);
  if (!target) return null;
  const status = fold(target.status || target.execution_status);
  if (/(executad|concluid|nao aplicavel|não aplicável)/.test(status)) return null;
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
      .eq('serial', serial)
      .order('service_date', { ascending: false })
      .limit(80),
    draft.client_name.trim()
      ? supabase.from('g4_client_summary').select('machine_count').ilike('client_name', `%${draft.client_name.trim()}%`).order('machine_count', { ascending: false }).limit(1)
      : Promise.resolve({ data: [], error: null } as any),
  ]);

  if (campaign) return campaign;

  const rows = (historyResult.data || []) as HistoryRow[];
  const stats = historyStats(rows);
  const hourmeter = currentHourmeter(draft, lastHourmeter);
  const currentText = [draft.service_reason, draft.description, machineContext?.last_operation_type].filter(Boolean).join(' ');
  if (!fold(currentText)) return null;

  const clientMachineCount = Number((clientResult.data || [])[0]?.machine_count || 0);
  const candidates = opportunityCandidates(currentText, hourmeter, stats, clientMachineCount)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0] || null;
  // Limiar de silêncio: nenhuma oportunidade aparece só porque existe histórico.
  // É necessário atingir relevância alta com sinais combinados.
  if (!best || best.score < 8) return null;
  return best;
}
