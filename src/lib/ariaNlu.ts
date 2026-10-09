// Interpretador local da ArIA: entende o pedido sem depender de IA externa.
// Sinônimos, tolerância a erro de digitação, datas em português e aprendizado por escolha do usuário.

export type NluIntent =
  | 'trocar_filial_tecnico' | 'agendar_atendimento' | 'remarcar_atendimento' | 'concluir_atendimento'
  | 'excluir_atendimento' | 'adicionar_tecnico' | 'desativar_tecnico' | 'criar_followup'
  | 'informar_cidade_maquina' | 'oportunidades_rota' | 'pendencias_filial' | 'navegar' | 'tecnicos_ociosos';

export type NluResult = { intent: NluIntent; score: number; args: Record<string, string> };
export type NluContext = { technicians: { name: string; branch: string }[]; branches: string[] };

export const INTENT_LABELS: Record<NluIntent, string> = {
  agendar_atendimento: 'Agendar atendimento',
  remarcar_atendimento: 'Remarcar atendimento',
  concluir_atendimento: 'Concluir atendimento',
  excluir_atendimento: 'Excluir atendimento',
  trocar_filial_tecnico: 'Trocar filial de técnico',
  adicionar_tecnico: 'Adicionar técnico',
  desativar_tecnico: 'Desativar técnico',
  criar_followup: 'Abrir follow-up',
  informar_cidade_maquina: 'Informar cidade da máquina',
  oportunidades_rota: 'Oportunidades na rota',
  pendencias_filial: 'Pendências 150h/campanhas',
  navegar: 'Abrir uma tela',
  tecnicos_ociosos: 'Técnicos sem atendimento',
};

const STOP = new Set(['o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'para', 'pra', 'pro', 'em', 'no', 'na', 'e', 'um', 'uma', 'que', 'com', 'por', 'me', 'eu', 'voce', 'favor', 'gostaria', 'quero', 'queria', 'preciso', 'pode', 'consegue', 'ai', 'ali', 'ja', 'hoje', 'ele', 'ela', 'dele', 'dela', 'esse', 'essa', 'este', 'esta', 'tecnico', 'tecnica', 'filial', 'atendimento', 'agendamento', 'visita', 'cliente']);

export function normalize(value: string) {
  return ` ${String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\w\s/:-]/g, ' ')
    .replace(/\bvc\b/g, 'voce').replace(/\bq\b/g, 'que').replace(/\btec\b/g, 'tecnico')
    .replace(/\bpro\b/g, 'para o').replace(/\bpra\b/g, 'para').replace(/\bpras?\b/g, 'para')
    .replace(/\bfollow ?up\b|\bfollowup\b|\bfup\b/g, 'followup')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

function lev(a: string, b: string) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function words(text: string) {
  return text.trim().split(' ').filter(Boolean);
}

// palavra parecida (tolera 1 erro em palavras >= 5 letras, 2 erros em >= 8)
function wordLike(word: string, target: string) {
  if (word === target) return true;
  if (target.length >= 5 && word.length >= 4) return lev(word, target) <= (target.length >= 8 ? 2 : 1);
  return false;
}

const NOUNS = /^(agendas?$|agendament|atendiment|programaca|marcaca|cadastr[oa]s?$|retorno$|visitas?$)/;

function hasStem(text: string, stems: string[], allowNouns = false) {
  const ws = words(text).filter((w) => allowNouns || !NOUNS.test(w));
  return stems.some((stem) => stem.includes(' ') ? text.includes(` ${stem}`) : ws.some((w) => w.startsWith(stem) || (stem.length >= 5 && wordLike(w.slice(0, stem.length + 2), stem))));
}

export function matchTechnician(text: string, techs: NluContext['technicians']) {
  const ws = words(text).filter((w) => !STOP.has(w) && w.length >= 3);
  let best: { name: string; branch: string; score: number } | null = null;
  for (const tech of techs) {
    const parts = normalize(tech.name).trim().split(' ').filter((p) => p.length >= 3);
    let score = 0;
    for (const part of parts) {
      if (ws.includes(part)) score += 3;
      else if (ws.some((w) => wordLike(w, part))) score += 2;
    }
    if (score > 0 && (!best || score > best.score)) best = { ...tech, score };
  }
  return best && best.score >= 2 ? best : null;
}

export function matchBranch(text: string, branches: string[], exclude?: string) {
  let best: { name: string; score: number } | null = null;
  for (const branch of branches) {
    if (branch === exclude) continue;
    const b = normalize(branch).trim();
    let score = 0;
    if (text.includes(` ${b} `)) score = 10;
    else {
      const bw = b.split(' ');
      const ws = words(text);
      const hits = bw.filter((part) => ws.some((w) => wordLike(w, part) || w === part || (part.length === 4 && w.length === 4 && lev(w, part) <= 1))).length;
      if (hits === bw.length) score = 6 + hits;
    }
    if (score && (!best || score > best.score)) best = { name: branch, score };
  }
  return best?.name || '';
}

const MONTHS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const WEEK = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Devolve todas as datas citadas, na ordem em que aparecem.
export function extractDates(raw: string, today = new Date()): string[] {
  const text = normalize(raw);
  const found: { pos: number; date: string }[] = [];
  const push = (pos: number, d: Date) => { if (!Number.isNaN(d.getTime())) found.push({ pos, date: iso(d) }); };
  const add = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };

  for (const m of text.matchAll(/\bdepois de amanha\b/g)) push(m.index!, add(2));
  for (const m of text.matchAll(/(?<!depois de )\bamanha\b/g)) push(m.index!, add(1));
  for (const m of text.matchAll(/\bhoje\b/g)) push(m.index!, add(0));
  for (const m of text.matchAll(/\bontem\b/g)) push(m.index!, add(-1));
  for (const m of text.matchAll(/\b(semana que vem|proxima semana)\b/g)) { const d = add(((8 - today.getDay()) % 7) || 7); push(m.index!, d); }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : today.getFullYear();
    push(m.index!, new Date(y, Number(m[2]) - 1, Number(m[1])));
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2}) de (${MONTHS.join('|')})(?: de (\\d{4}))?\\b`, 'g'))) {
    push(m.index!, new Date(m[3] ? Number(m[3]) : today.getFullYear(), MONTHS.indexOf(m[2]), Number(m[1])));
  }
  for (const m of text.matchAll(/\bdia (\d{1,2})\b(?! de)/g)) {
    const day = Number(m[1]);
    const d = new Date(today.getFullYear(), today.getMonth(), day);
    if (d < add(-1)) d.setMonth(d.getMonth() + 1);
    push(m.index!, d);
  }
  for (const m of text.matchAll(new RegExp(`\\b(proxima |proximo |nessa |nesta |essa |esta )?(${WEEK.join('|')})(?:-feira| feira)?\\b`, 'g'))) {
    const idx = WEEK.indexOf(m[2]);
    let diff = (idx - today.getDay() + 7) % 7;
    if ((m[1] || '').startsWith('prox')) diff = diff || 7;
    push(m.index!, add(diff));
  }
  return found.sort((a, b) => a.pos - b.pos).map((f) => f.date).filter((d, i, arr) => arr.indexOf(d) === i);
}

export function extractPin(raw: string) {
  const m = raw.toUpperCase().match(/\b(?=[A-Z0-9]*\d{4})[A-Z]{2,5}[A-Z0-9]{8,16}\b/);
  return m ? m[0] : '';
}

// Texto livre depois de uma palavra-chave (ex.: "cliente X", "para o X").
function tailAfter(raw: string, keys: RegExp) {
  const m = raw.match(keys);
  if (!m) return '';
  return m[1].replace(/\s+(amanh[ãa]|hoje|ontem|dia \d+|semana que vem|pr[óo]xim[ao]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|na |no |em |para |pra |com ).*$/i, '').trim();
}

type Rule = { intent: NluIntent; strong: string[]; weak?: string[]; objects?: string[]; bonus?: (ctx: Slots, text: string) => number };
type Slots = { tech: string; branch: string; dates: string[]; pin: string; city: string; screen: string };

const QUESTION = /^ (quem|quais|qual|quanto|quantos|quantas|como|onde|quando|tem |existe|o que) /;

const RULES: Rule[] = [
  { intent: 'trocar_filial_tecnico', strong: ['realoc'], weak: ['troc', 'mud', 'transfer', 'pass', 'mov', 'alter', 'jog', 'coloc', 'associ', 'lev', 'mand', 'vai atender', 'devolv', 'volt', 'retorn'], objects: ['filial', 'base', 'unidade', 'regional'], bonus: (s) => (s.tech && s.branch && !s.dates.length ? 4 : 0) - (s.dates.length ? 4 : 0) },
  { intent: 'agendar_atendimento', strong: ['agend', 'encaix', 'novo atendimento', 'nova visita', 'coloc na agenda', 'coloca na agenda', 'program', 'marc'], weak: ['cri', 'mand', 'bot', 'coloc'], objects: ['visita', 'atendimento', '150', '150h', 'campanha', 'revisao', 'garantia', 'diagnostico', 'pmp', 'entrega'], bonus: (s, t) => (s.pin ? 2 : 0) - (QUESTION.test(t) ? 5 : 0) },
  { intent: 'remarcar_atendimento', strong: ['remarc', 'reagend', 'adi', 'antecip', 'posterg', 'empurr'], weak: ['troc', 'mud', 'pass', 'jog', 'transfer', 'mov', 'bot', 'coloc', 'volt', 'devolv'], objects: ['dia', 'data', 'atendimento', 'visita', 'agendamento', 'horario'], bonus: (s) => (s.dates.length ? 3 : 0) - (s.branch && !s.dates.length ? 4 : 0) },
  { intent: 'concluir_atendimento', strong: ['conclu', 'finaliz', 'termin', 'execut', 'baix', 'feito', 'realiz'], weak: ['encerr', 'fech'], objects: ['atendimento', 'visita', 'servico', 'os', 'ordem'] },
  { intent: 'excluir_atendimento', strong: ['exclu', 'apag', 'cancel', 'desmarc', 'delet'], weak: ['remov', 'tir'], objects: ['atendimento', 'agendamento', 'visita', 'agenda', 'os'], bonus: (s, t) => (/\btecnic/.test(t) ? -4 : 0) - (!s.tech && !s.pin && !s.dates.length && !/atendiment|agendament|visita|agenda/.test(t) ? 4 : 0) },
  { intent: 'adicionar_tecnico', strong: ['contrat', 'entrou'], weak: ['adicion', 'cadastr', 'inclu', 'cri', 'novo', 'nova', 'registr'], objects: ['tecnico', 'tecnica', 'mecanico'] },
  { intent: 'desativar_tecnico', strong: ['desativ', 'inativ', 'deslig', 'saiu', 'demit', 'demiss', 'pediu as contas'], weak: ['remov', 'tir', 'exclu', 'bloque'], objects: ['tecnico', 'tecnica', 'mecanico', 'empresa'], bonus: (s) => (s.tech ? 1 : 0) },
  { intent: 'criar_followup', strong: ['followup', 'tratativa', 'prospect'], weak: ['abr', 'cri', 'nov', 'registr', 'lig', 'retorn', 'lembr', 'cobr', 'acompanh'], objects: ['retorno', 'contato', 'ligar', 'oportunidade', 'prospeccao'], bonus: (_s, t) => (QUESTION.test(t) ? -6 : 0) },
  { intent: 'informar_cidade_maquina', strong: ['esta em', 'fica em', 'localizad', 'trabalhando em', 'rodando em', 'operando em'], weak: ['cidade'], objects: ['maquina', 'equipamento', 'pin', 'serie'], bonus: (s) => (s.pin ? 3 : -3) },
  { intent: 'oportunidades_rota', strong: ['aproveit'], weak: ['oportunidad', 'pendenc', 'encaix', 'pass'], objects: ['rota', 'viagem', 'regiao', 'caminho', 'semana', 'passando'], bonus: (s) => (s.tech ? 2 : -2) },
  { intent: 'pendencias_filial', strong: ['pendenc', 'pendente', 'falt', 'resumo', 'situacao'], weak: ['quant', 'status', 'aberto'], objects: ['150', '150h', 'campanha', 'campanhas', 'inspecao', 'filial', 'programar'], bonus: (s) => (s.tech ? -2 : 0) },
  { intent: 'tecnicos_ociosos', strong: ['ocios', 'disponive', 'livre', 'sem agenda', 'sem atendimento', 'sem servico', 'parado', 'desocupad', 'vago', 'folgad'], weak: ['quem', 'quais'], objects: ['tecnico', 'tecnicos', 'equipe', 'pessoal', 'turma'], bonus: (s, t) => (/\bclientes?\b/.test(t) ? -6 : 0) + (/tecnic|equipe|pessoal|turma/.test(t) ? 2 : -4) },
  { intent: 'navegar', strong: ['ir para', 'vai para', 'me leva', 'leva para'], weak: ['abr', 'mostr', 'acess', 'entra'], objects: ['tela', 'agenda', 'retencao', 'mapa', 'followup', 'dashboard', 'painel', 'campanhas', '150', 'usuarios'] },
];

const LEARN_KEY = 'aria-learned-intents-v1';

type Learned = { tokens: string[]; intent: NluIntent };

function keyTokens(text: string, ctx: NluContext) {
  const techTokens = new Set(ctx.technicians.flatMap((t) => normalize(t.name).trim().split(' ')));
  const branchTokens = new Set(ctx.branches.flatMap((b) => normalize(b).trim().split(' ')));
  return words(text).filter((w) => w.length >= 3 && !STOP.has(w) && !techTokens.has(w) && !branchTokens.has(w) && !/\d/.test(w) && !WEEK.includes(w) && !MONTHS.includes(w));
}

function loadLearned(): Learned[] {
  try { return JSON.parse(localStorage.getItem(LEARN_KEY) || '[]'); } catch { return []; }
}

export function learnIntent(message: string, intent: NluIntent, ctx: NluContext) {
  const tokens = keyTokens(normalize(message), ctx);
  if (!tokens.length) return;
  const list = loadLearned().filter((item) => item.tokens.join(' ') !== tokens.join(' '));
  list.unshift({ tokens, intent });
  try { localStorage.setItem(LEARN_KEY, JSON.stringify(list.slice(0, 200))); } catch { /* sem armazenamento */ }
}

function learnedIntent(text: string, ctx: NluContext): NluIntent | null {
  const tokens = keyTokens(text, ctx);
  if (!tokens.length) return null;
  let best: { intent: NluIntent; sim: number } | null = null;
  for (const item of loadLearned()) {
    const inter = item.tokens.filter((t) => tokens.some((w) => wordLike(w, t))).length;
    const sim = inter / Math.max(item.tokens.length, tokens.length);
    if (sim >= 0.6 && (!best || sim > best.sim)) best = { intent: item.intent, sim };
  }
  return best?.intent || null;
}

export function interpret(raw: string, ctx: NluContext, forced?: NluIntent, memory?: { tech?: string }): NluResult | null {
  const text = normalize(raw);
  let tech = matchTechnician(text, ctx.technicians);
  if (!tech && memory?.tech && /\b(ele|ela|dele|dela|o mesmo|a mesma|esse tecnico|essa tecnica|mesmo tecnico|nele|nela)\b/.test(text)) {
    const remembered = ctx.technicians.find((t) => t.name === memory.tech);
    if (remembered) tech = { ...remembered, score: 3 };
  }
  const slots: Slots = {
    tech: tech?.name || '',
    branch: matchBranch(text, ctx.branches, tech?.branch),
    dates: extractDates(raw),
    pin: extractPin(raw),
    city: tailAfter(raw, /(?:est[áa]|fica|localizad[ao]|trabalhando|rodando|operando)\s+em\s+([^,.;!?]+)/i),
    screen: '',
  };

  let best: NluResult | null = null;
  for (const rule of RULES) {
    const strong = hasStem(text, rule.strong);
    const weak = !strong && rule.weak ? hasStem(text, rule.weak) : false;
    const object = rule.objects ? hasStem(text, rule.objects, true) : false;
    if (!strong && !weak && !object) continue;
    if (rule.intent === 'remarcar_atendimento' && !strong && !weak) continue;
    let score = (strong ? 5 : weak ? 2 : 0) + (object ? 2 : 0) + (rule.bonus ? rule.bonus(slots, text) : 0);
    if (rule.intent === 'agendar_atendimento' && /^ (agenda|preciso de|precisa de|quero) (uma|um|o|a|para|com|visita|atendimento)\b/.test(text)) score += 5;
    if (rule.intent === 'agendar_atendimento' && /\bmarca(r)? como\b/.test(text)) score -= 6;
    if (rule.intent === 'concluir_atendimento' && /\bmarca(r)? como\b/.test(text)) score += 2;
    const newOne = /\b(uma|um|nova|novo) (visita|atendimento|revisao|campanha|150|garantia|diagnostico|entrega|os)\b/.test(text);
    if (rule.intent === 'agendar_atendimento' && newOne) score += 4;
    if (rule.intent === 'remarcar_atendimento' && newOne) score -= 4;
    if (rule.intent === 'navegar' && !/\b(abr|ir para|vai para|mostr|acess|entra|leva)/.test(text)) score -= 3;
    if (rule.intent === 'navegar' && slots.tech) score -= 5;
    const aboutClients = /\bclientes?\b/.test(text) && !/\btecnic/.test(text) && !slots.tech;
    if (aboutClients && ['desativar_tecnico', 'adicionar_tecnico', 'trocar_filial_tecnico', 'tecnicos_ociosos'].includes(rule.intent)) score -= 8;
    if (score > (best?.score ?? 0)) best = { intent: rule.intent, score, args: {} };
  }

  const learned = learnedIntent(text, ctx);
  if (learned && (!best || best.score < 6)) best = { intent: learned, score: 6, args: {} };
  if (forced) best = { intent: forced, score: 10, args: {} };
  if (!best || best.score < 4) return null;

  const [d1, d2] = slots.dates;
  const clientTail = tailAfter(raw, /(?:cliente|empresa|da|do|para a|para o|pra|pro)\s+([A-ZÀ-Ú0-9][\wÀ-ú&.\- ]{2,60})/);
  const tail = clientTail && !matchTechnician(normalize(clientTail), ctx.technicians) && !matchBranch(normalize(clientTail), ctx.branches) ? clientTail : '';
  const nameAfterTech = tailAfter(raw, /(?:chamad[oa]|nome(?: d[eo])?|t[ée]cnic[oa](?: nov[oa])?)\s+(?!nov[oa]\b|chamad)([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)?)/);

  switch (best.intent) {
    case 'trocar_filial_tecnico': best.args = { tecnico: slots.tech, filial: slots.branch }; break;
    case 'agendar_atendimento': {
      const tipo = /\b150\b|150h|cento e cinquenta/.test(text) ? 'Visita 150h' : /campanha/.test(text) ? 'Campanha de campo'
        : /garantia/.test(text) ? 'Garantia' : /\bpmp\b|preventiv/.test(text) ? 'Revisão PMP' : /diagnost/.test(text) ? 'Diagnóstico'
          : /entrega tecnica|\bet\b/.test(text) ? 'Entrega Técnica' : /oficina/.test(text) ? 'Oficina' : '';
      best.args = { tipo, pin: slots.pin, cliente: tail, tecnico: slots.tech, data: d1 || '' };
      break;
    }
    case 'remarcar_atendimento': best.args = { tecnico: slots.tech, cliente_ou_pin: slots.pin || tail, data_atual: d2 ? d1 : '', nova_data: d2 || d1 || '' }; break;
    case 'concluir_atendimento':
    case 'excluir_atendimento': best.args = { tecnico: slots.tech, cliente_ou_pin: slots.pin || tail, data: d1 || '' }; break;
    case 'adicionar_tecnico': best.args = { nome: slots.tech ? '' : nameAfterTech, filial: matchBranch(text, ctx.branches) }; break;
    case 'desativar_tecnico': best.args = { tecnico: slots.tech }; break;
    case 'criar_followup': best.args = { cliente: tail, data_retorno: d1 || '' }; break;
    case 'informar_cidade_maquina': best.args = { pin: slots.pin, cidade: slots.city }; break;
    case 'oportunidades_rota': best.args = { tecnico: slots.tech }; break;
    case 'pendencias_filial': best.args = { filial: matchBranch(text, ctx.branches) }; break;
    case 'navegar': best.args = { tela: text }; break;
    case 'tecnicos_ociosos': best.args = { data: d1 || '', filial: matchBranch(text, ctx.branches) }; break;
  }
  return best;
}
