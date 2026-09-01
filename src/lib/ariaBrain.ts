import { supabase } from './supabase';
import type { AppUser } from '../session';
import type { Followup, HistoryRow } from '../types';

export type ArIAAction = {
  label: string;
  view?: 'inicio' | 'agenda' | 'retencao' | 'followup' | 'dashboard';
  mode?: 'list' | 'map';
  tab?: 'active' | 'calendar' | 'history';
  tutorial?: boolean;
};

export type ArIAReply = { text: string; actions?: ArIAAction[] };

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const DAY = 86400000;

export function foldArIA(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function localIso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function isoToday() { return localIso(new Date()); }
function saleValue(item: Followup) {
  const closed = Number(item.parts_value || 0) + Number(item.services_value || 0);
  return closed > 0 ? closed : Number(item.estimated_value || 0);
}
function monthsWithoutService(date: string | null | undefined) {
  if (!date) return 999;
  return Math.max(0, (Date.now() - new Date(date).getTime()) / (DAY * 30.44));
}
function retentionLabel(date: string | null | undefined) {
  const months = monthsWithoutService(date);
  if (months <= 3) return 'até 3 meses';
  if (months <= 6) return '3–6 meses';
  if (months <= 12) return '6–12 meses';
  if (months <= 18) return '12–18 meses';
  return '+18 meses';
}
function requestedCount(message: string, fallback = 5) {
  const found = foldArIA(message).match(/\b(\d{1,2})\s+(?:clientes?|oportunidades?|sugestoes?|sugestões?)/)?.[1];
  return found ? Math.max(1, Math.min(12, Number(found))) : fallback;
}
function weekBounds() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  const saturday = new Date(monday);
  saturday.setDate(monday.getDate() + 5);
  return { start: localIso(monday), end: localIso(saturday) };
}

function capabilities(): ArIAReply {
  return {
    text: `Posso trabalhar com o contexto real do sistema, não apenas responder perguntas. Hoje consigo:\n\n• consultar a Agenda e os próximos atendimentos de qualquer técnico;\n• identificar as cidades onde um técnico estará na semana e sugerir clientes da Retenção naquela região;\n• buscar clientes inativos por cidade e por tempo sem atendimento, inclusive pedidos como “3 clientes de Barcarena há mais de 1 ano”;\n• mostrar contatos de Follow-up vencidos ou para hoje;\n• consultar oportunidades abertas com valor;\n• resumir cliente, máquinas, histórico G4 e o que foi feito no último atendimento;\n• consultar as faixas reais de Retenção: até 3, 3–6, 6–12, 12–18 e +18 meses;\n• abrir Agenda, Retenção, mapa, Follow-up, Histórico e Dashboard;\n• repetir o tutorial quando você pedir;\n• aprender com correções dos usuários. Se eu interpretar algo errado, diga “não, o correto é...” ou “corrigindo: ...”. Eu registro a correção para melhorar pedidos semelhantes.\n\nQuando eu sugerir clientes pela rota, eu não trato isso como oportunidade já aberta: são clientes potenciais encontrados pela Agenda + Retenção. E não afirmo distância ou tempo sem um cálculo real de rota.`,
    actions: [
      { label: 'Abrir Agenda', view: 'agenda' },
      { label: 'Abrir Retenção', view: 'retencao' },
      { label: 'Abrir Follow-up', view: 'followup' },
      { label: 'Ver tutorial', tutorial: true },
    ],
  };
}

export function isArIACorrection(message: string) {
  const text = foldArIA(message);
  return /^(nao[, ]|não[, ]|corrigindo|correcao|correção|o correto|isso esta errado|isso está errado|voce entendeu errado|você entendeu errado)/.test(text)
    || text.includes('o correto e') || text.includes('o correto é');
}

export async function learnArIACorrection(originalQuestion: string, originalAnswer: string, correction: string, user: AppUser) {
  const payload = {
    original_question: originalQuestion,
    original_answer: originalAnswer,
    correction,
    normalized_question: foldArIA(originalQuestion),
    created_by_matricula: user.matricula,
    created_by_name: user.name,
  };
  const { error } = await supabase.from('aria_learning').insert(payload);
  return !error;
}

async function learnedFallback(message: string): Promise<ArIAReply | null> {
  const tokens = foldArIA(message).split(/\s+/).filter((item) => item.length >= 4 && !['cliente','clientes','quero','mostre','mostrar','pode','para','essa','esta','semana'].includes(item));
  if (!tokens.length) return null;
  const { data } = await supabase.from('aria_learning').select('original_question,correction,created_at').eq('active', true).order('created_at', { ascending: false }).limit(80);
  let best: any = null;
  let bestScore = 0;
  for (const row of data || []) {
    const learned = foldArIA(row.original_question || '');
    const score = tokens.filter((token) => learned.includes(token)).length;
    if (score > bestScore) { best = row; bestScore = score; }
  }
  if (!best || bestScore < Math.min(2, tokens.length)) return null;
  return { text: `Tenho uma correção aprendida para um pedido parecido:\n\n${best.correction}\n\nSe quiser, reformule só o objeto da consulta (cidade, técnico ou período) que eu aplico essa orientação.` };
}

async function followupsToday(user: AppUser): Promise<ArIAReply> {
  const today = isoToday();
  const { data, error } = await supabase.from('followups').select('*').neq('stage', 'encerrar').or(`created_by_matricula.eq.${user.matricula},updated_by_matricula.eq.${user.matricula}`).order('next_followup_date', { ascending: true });
  if (error) return { text: 'Não consegui consultar o Follow-up agora.' };
  const due = ((data || []) as Followup[]).filter((item) => item.next_followup_date && item.next_followup_date <= today);
  if (!due.length) return { text: 'Você não possui contatos vencidos ou programados para hoje.', actions: [{ label: 'Abrir Follow-up', view: 'followup' }] };
  const top = due.slice(0, 6).map((item, index) => `${index + 1}. ${item.client_name} — ${item.next_followup_date === today ? 'hoje' : `atrasado desde ${dateFmt.format(new Date(`${item.next_followup_date}T12:00:00`))}`}${saleValue(item) > 0 ? ` — ${money.format(saleValue(item))}` : ''}`);
  return { text: `Eu priorizaria estes contatos:\n\n${top.join('\n')}`, actions: [{ label: 'Abrir Follow-up', view: 'followup', tab: 'active' }, { label: 'Agenda de contatos', view: 'followup', tab: 'calendar' }] };
}

async function opportunities(user: AppUser): Promise<ArIAReply> {
  const { data, error } = await supabase.from('followups').select('*').neq('stage', 'encerrar').or(`created_by_matricula.eq.${user.matricula},updated_by_matricula.eq.${user.matricula}`);
  if (error) return { text: 'Não consegui consultar as oportunidades agora.' };
  const rows = ((data || []) as Followup[]).filter((item) => saleValue(item) > 0).sort((a, b) => saleValue(b) - saleValue(a));
  if (!rows.length) return { text: 'Você não possui oportunidades abertas com valor informado neste momento.', actions: [{ label: 'Abrir Follow-up', view: 'followup' }] };
  return { text: `Encontrei ${rows.length} oportunidade(s) aberta(s) com valor. As maiores são:\n\n${rows.slice(0, 6).map((item, index) => `${index + 1}. ${item.client_name} — ${money.format(saleValue(item))}`).join('\n')}`, actions: [{ label: 'Ver oportunidades', view: 'followup', tab: 'active' }] };
}

async function findTechnicianInMessage(message: string) {
  const { data } = await supabase.from('technicians').select('id,name,branch').eq('active', true).order('name');
  const text = foldArIA(message);
  return (data || []).find((item: any) => text.includes(foldArIA(item.name))) as any | undefined;
}

async function technicianRegionProspects(message: string): Promise<ArIAReply> {
  const tech = await findTechnicianInMessage(message);
  if (!tech) return { text: 'Entendi que você quer sugestões de clientes na região da rota, mas não identifiquei o técnico. Diga, por exemplo: “clientes na região que o Almivar atende esta semana”.' };
  const { start, end } = weekBounds();
  const { data: agenda, error } = await supabase.from('appointments').select('client_name,service_city,appointment_date').eq('technician_id', tech.id).gte('appointment_date', start).lte('appointment_date', end).order('appointment_date');
  if (error) return { text: 'Não consegui consultar a agenda do técnico agora.' };
  const cities = Array.from(new Set((agenda || []).map((item: any) => String(item.service_city || '').trim()).filter(Boolean)));
  if (!cities.length) return { text: `${tech.name} não possui cidades de atendimento informadas nesta semana. Sem isso eu não vou inventar uma região.`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }] };

  const candidates: any[] = [];
  for (const city of cities.slice(0, 8)) {
    const { data } = await supabase.from('g4_client_city_summary').select('client_key,client_name,branch,city,last_service_at,service_count,machine_count').ilike('city', city).order('last_service_at', { ascending: true }).limit(80);
    candidates.push(...(data || []));
  }
  const scheduledNames = new Set((agenda || []).map((item: any) => foldArIA(String(item.client_name || ''))).filter(Boolean));
  const { data: openFollowups } = await supabase.from('followups').select('client_name,branch').neq('stage', 'encerrar').limit(1000);
  const openKeys = new Set((openFollowups || []).map((item: any) => `${foldArIA(item.client_name || '')}|${foldArIA(item.branch || '')}`));
  const unique = new Map<string, any>();
  for (const row of candidates) {
    const key = `${foldArIA(row.client_name || '')}|${foldArIA(row.branch || '')}`;
    if (!row.client_name || scheduledNames.has(foldArIA(row.client_name)) || openKeys.has(key)) continue;
    if (!unique.has(key)) unique.set(key, row);
  }
  const ranked = Array.from(unique.values()).sort((a, b) => monthsWithoutService(b.last_service_at) - monthsWithoutService(a.last_service_at));
  const count = requestedCount(message, 5);
  const top = ranked.slice(0, count);
  if (!top.length) return { text: `Consultei ${cities.join(', ')} pela agenda do ${tech.name}, mas não encontrei clientes livres para sugerir agora (desconsiderando clientes já agendados ou com Follow-up aberto).` };
  const lines = top.map((row, index) => `${index + 1}. ${row.client_name} — ${row.city} — último atendimento ${row.last_service_at ? dateFmt.format(new Date(row.last_service_at)) : 'sem data'} — ${retentionLabel(row.last_service_at)} — ${row.service_count} OS`);
  return {
    text: `${tech.name} está com atendimentos em ${cities.join(', ')} nesta semana. Em vez de listar oportunidades já abertas, cruzei a Agenda com a Retenção e encontrei clientes potenciais nessas regiões:\n\n${lines.join('\n')}\n\nEssas são sugestões por cidade/Retenção. Ainda não estou afirmando distância do trajeto até cada cliente sem o cálculo real da malha viária.`,
    actions: [{ label: 'Ver no mapa', view: 'retencao', mode: 'map' }, { label: 'Abrir Retenção', view: 'retencao' }],
  };
}

function cityFromMessage(message: string) {
  const raw = message.replace(/[?!.,]+$/g, ' ');
  const match = raw.match(/(?:clientes?\s+(?:de|em)|\b(?:de|em))\s+([A-Za-zÀ-ÿ' -]+?)(?=\s+(?:que|com|inativ|sem|ha|há|mais|por|na|no|da|do)\b|$)/i);
  return match?.[1]?.trim() || '';
}
function inactivityDaysFromMessage(message: string) {
  const text = foldArIA(message);
  const years = text.match(/(?:mais de|ha mais de|há mais de)\s+(\d+)\s+anos?/)?.[1];
  if (years) return Number(years) * 365;
  if (/(mais de|ha mais de|há mais de)\s+(um|1)\s+ano/.test(text)) return 365;
  const months = text.match(/(?:mais de|ha mais de|há mais de)\s+(\d+)\s+mes/)?.[1];
  if (months) return Number(months) * 30.44;
  return /inativ|sem atendimento|mais tempo/.test(text) ? 365 : 0;
}

async function inactiveClientsByCity(message: string): Promise<ArIAReply> {
  const city = cityFromMessage(message);
  if (!city) return { text: 'Entendi que você quer clientes inativos, mas não consegui identificar a cidade.' };
  const minDays = inactivityDaysFromMessage(message);
  const count = requestedCount(message, 5);
  const { data, error } = await supabase.from('g4_client_city_summary').select('client_name,branch,city,last_service_at,service_count,machine_count').ilike('city', `%${city}%`).order('last_service_at', { ascending: true }).limit(200);
  if (error) return { text: 'Não consegui consultar a Retenção por cidade agora.' };
  const rows = (data || []).filter((row: any) => row.last_service_at && (Date.now() - new Date(row.last_service_at).getTime()) / DAY >= minDays);
  if (!rows.length) return { text: `Não encontrei clientes em ${city} dentro do tempo de inatividade solicitado.` };
  const top = rows.slice(0, count);
  return {
    text: `Encontrei ${rows.length} cliente(s) em ${top[0].city} dentro do critério. Mostrando ${top.length}:\n\n${top.map((row: any, index: number) => `${index + 1}. ${row.client_name} — último atendimento ${dateFmt.format(new Date(row.last_service_at))} — ${retentionLabel(row.last_service_at)} — ${row.service_count} OS`).join('\n')}`,
    actions: [{ label: 'Abrir Retenção', view: 'retencao' }, { label: 'Ver no mapa', view: 'retencao', mode: 'map' }],
  };
}

async function clientSummary(message: string): Promise<ArIAReply> {
  const quoted = message.match(/[“\"']([^”\"']+)[”\"']/)?.[1]?.trim();
  let term = quoted || message.replace(/^.*?(?:cliente|com a|com o)\s+/i, '').replace(/[?.!]+$/, '').trim();
  if (term.length < 3) return { text: 'Me diga o nome do cliente.' };
  const [{ data: clientRows }, { data: historyRows }] = await Promise.all([
    supabase.from('g4_client_summary').select('client_name,branch,city,last_service_at,service_count,machine_count,last_description').ilike('client_name', `%${term}%`).order('last_service_at', { ascending: false }).limit(5),
    supabase.from('g4_history_app').select('client_name,serial,city,branch,operation_type,service_date,description').ilike('client_name', `%${term}%`).order('service_date', { ascending: false }).limit(5),
  ]);
  const client = (clientRows || [])[0] as any;
  const history = (historyRows || [])[0] as HistoryRow | undefined;
  if (!client) return { text: `Não encontrei cliente correspondente a “${term}”.` };
  const lastDate = history?.service_date || client.last_service_at;
  return { text: `Resumo de ${client.client_name}:\n\n${client.city || 'Cidade não informada'} · filial ${client.branch}\n${client.machine_count} máquina(s) · ${client.service_count} OS\nÚltimo atendimento: ${lastDate ? dateFmt.format(new Date(lastDate)) : 'não informado'}\nFaixa de retenção: ${retentionLabel(lastDate)}${history?.serial ? `\nMáquina: ${history.serial}` : ''}\nO que foi feito: ${history?.description || client.last_description || 'Sem descrição registrada no G4'}`, actions: [{ label: 'Abrir Retenção', view: 'retencao' }] };
}

async function technicianAgenda(message: string): Promise<ArIAReply> {
  const tech = await findTechnicianInMessage(message);
  if (!tech) return { text: 'Não identifiquei o técnico nesse pedido.' };
  const today = new Date(); const end = new Date(today); end.setDate(today.getDate() + 14);
  const { data } = await supabase.from('appointments').select('appointment_date,client_name,service_city,service_reason').eq('technician_id', tech.id).gte('appointment_date', localIso(today)).lte('appointment_date', localIso(end)).order('appointment_date').limit(15);
  const rows = data || [];
  if (!rows.length) return { text: `${tech.name} não possui atendimentos nos próximos 14 dias.`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }] };
  return { text: `${tech.name} · ${tech.branch}\nPróximos atendimentos:\n\n${rows.map((item: any, index: number) => `${index + 1}. ${dateFmt.format(new Date(`${item.appointment_date}T12:00:00`))} — ${item.client_name || 'Cliente não informado'}${item.service_city ? ` · ${item.service_city}` : ''}`).join('\n')}`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }, { label: 'Ver mapa', view: 'retencao', mode: 'map' }] };
}

export async function answerArIA(message: string, user: AppUser): Promise<ArIAReply> {
  const text = foldArIA(message);
  if (!text) return { text: 'Pode falar comigo.' };
  if (text.includes('tutorial')) return { text: 'Claro. Vou abrir o tutorial novamente.', actions: [{ label: 'Iniciar tutorial', tutorial: true }] };
  if (/o que (voce|vc) (faz|consegue)|como (voce|vc) pode ajudar|suas funcoes|capacidade|capacidades/.test(text)) return capabilities();

  // Contexto de rota vem antes de "oportunidade", porque aqui oportunidade significa cliente potencial na região.
  if (/(regiao|rota|onde).*(tecnico|atend|semana)|oportunidades?.*(regiao|rota)|clientes?.*(regiao|rota)/.test(text) && await findTechnicianInMessage(message)) return technicianRegionProspects(message);

  if (/clientes?/.test(text) && /(inativ|sem atendimento|mais de .*ano|mais de .*mes|mais tempo)/.test(text) && /\b(de|em)\b/.test(text)) return inactiveClientsByCity(message);
  if (/quem.*(ligar|contatar|contactar)|contatos?.*hoje|follow.?up.*hoje|retorno.*hoje|atrasad/.test(text)) return followupsToday(user);
  if (/oportunidade|proposta.*sem retorno|valor.*follow|venda.*andamento/.test(text)) return opportunities(user);
  if (/agenda.*tecnico|agenda.*técnico|onde.*tecnico|onde.*técnico|proximos agendamentos/.test(text) || await findTechnicianInMessage(message)) return technicianAgenda(message);
  if (/o que aconteceu|ultima vez|historico.*cliente|resumo.*cliente|me prepare.*cliente/.test(text)) return clientSummary(message);
  if (/abrir.*agenda|ir.*agenda/.test(text)) return { text: 'Abrindo a Agenda.', actions: [{ label: 'Abrir Agenda', view: 'agenda' }] };
  if (/abrir.*retenc|ir.*retenc/.test(text)) return { text: 'Abrindo a Retenção.', actions: [{ label: 'Abrir Retenção', view: 'retencao' }] };
  if (/abrir.*mapa|ver.*mapa/.test(text)) return { text: 'Abrindo o mapa.', actions: [{ label: 'Abrir mapa', view: 'retencao', mode: 'map' }] };
  if (/abrir.*follow|ir.*follow/.test(text)) return { text: 'Abrindo o Follow-up.', actions: [{ label: 'Abrir Follow-up', view: 'followup' }] };
  if (/abrir.*dashboard|ver.*dashboard/.test(text)) return { text: 'Abrindo o Dashboard.', actions: [{ label: 'Abrir Dashboard', view: 'dashboard' }] };

  const learned = await learnedFallback(message);
  if (learned) return learned;
  return { text: 'Ainda não consegui interpretar esse pedido com segurança. Posso consultar Agenda, Retenção, histórico G4, mapa e Follow-up. Se eu estiver entendendo uma expressão sua errado, me corrija com “não, o correto é...” que eu registro esse aprendizado.' };
}
