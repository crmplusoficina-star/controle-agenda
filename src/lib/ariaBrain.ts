import { supabase } from './supabase';
import type { AppUser } from '../session';
import type { Followup, HistoryRow } from '../types';

export type ArIAAction = {
  label: string;
  view?: 'inicio' | 'agenda' | 'retencao' | 'followup';
  mode?: 'list' | 'map';
  tab?: 'active' | 'calendar' | 'history';
  tutorial?: boolean;
};

export type ArIAReply = {
  text: string;
  actions?: ArIAAction[];
};

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

function fold(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function isoToday() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function saleValue(item: Followup) {
  const closed = Number(item.parts_value || 0) + Number(item.services_value || 0);
  return closed > 0 ? closed : Number(item.estimated_value || 0);
}

function retentionLabel(date: string | null) {
  if (!date) return '+18 meses';
  const months = Math.max(0, (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24 * 30.44));
  if (months <= 3) return 'até 3 meses';
  if (months <= 6) return '3–6 meses';
  if (months <= 12) return '6–12 meses';
  if (months <= 18) return '12–18 meses';
  return '+18 meses';
}

function capabilities(): ArIAReply {
  return {
    text: `Hoje eu consigo trabalhar com o contexto real da Agenda Técnica. Posso:\n\n• consultar agenda e próximos atendimentos dos técnicos;\n• mostrar quem você precisa contatar hoje e follow-ups atrasados;\n• localizar oportunidades com valor e tratativas sem atualização;\n• resumir cliente, máquinas e último atendimento do G4;\n• explicar a faixa real de Retenção: até 3, 3–6, 6–12, 12–18 e +18 meses;\n• procurar clientes por cidade e destacar os que estão há mais tempo sem atendimento;\n• abrir Agenda, Retenção, mapa, Follow-up e Histórico;\n• iniciar novamente o tutorial.\n\nTambém fui preparada para evoluir para análise de clientes próximos da rota, comparação de rotas e recomendações comerciais. Nessas funções eu só afirmarei distância/tempo quando houver cálculo real da rota e nunca vou alterar agenda ou tratativa sem confirmação.`,
    actions: [
      { label: 'Ir para Agenda', view: 'agenda' },
      { label: 'Abrir Retenção', view: 'retencao' },
      { label: 'Ver Follow-up', view: 'followup' },
      { label: 'Ver tutorial', tutorial: true },
    ],
  };
}

async function followupsToday(user: AppUser): Promise<ArIAReply> {
  const today = isoToday();
  const { data, error } = await supabase
    .from('followups')
    .select('*')
    .neq('stage', 'encerrar')
    .or(`created_by_matricula.eq.${user.matricula},updated_by_matricula.eq.${user.matricula}`)
    .order('next_followup_date', { ascending: true });
  if (error) return { text: 'Não consegui consultar o Follow-up agora. Tente novamente em instantes.' };
  const rows = (data || []) as Followup[];
  const due = rows.filter((item) => item.next_followup_date && item.next_followup_date <= today);
  if (!due.length) return { text: 'Você não possui contatos vencidos ou programados para hoje.', actions: [{ label: 'Abrir Follow-up', view: 'followup' }] };
  const top = due.slice(0, 6).map((item, index) => {
    const when = item.next_followup_date === today ? 'hoje' : `atrasado desde ${dateFmt.format(new Date(`${item.next_followup_date}T12:00:00`))}`;
    const value = saleValue(item);
    return `${index + 1}. ${item.client_name} — ${when}${value > 0 ? ` — ${money.format(value)}` : ''}`;
  });
  return { text: `Eu priorizaria estes contatos:\n\n${top.join('\n')}${due.length > top.length ? `\n\nHá mais ${due.length - top.length} contato(s) nessa condição.` : ''}`, actions: [{ label: 'Abrir Follow-up', view: 'followup', tab: 'active' }, { label: 'Ver agenda de contatos', view: 'followup', tab: 'calendar' }] };
}

async function opportunities(user: AppUser): Promise<ArIAReply> {
  const { data, error } = await supabase
    .from('followups')
    .select('*')
    .neq('stage', 'encerrar')
    .or(`created_by_matricula.eq.${user.matricula},updated_by_matricula.eq.${user.matricula}`)
    .order('updated_at', { ascending: true });
  if (error) return { text: 'Não consegui consultar as oportunidades agora.' };
  const rows = ((data || []) as Followup[]).filter((item) => saleValue(item) > 0);
  if (!rows.length) return { text: 'Você não possui oportunidades abertas com valor informado neste momento.', actions: [{ label: 'Abrir Follow-up', view: 'followup' }] };
  rows.sort((a, b) => saleValue(b) - saleValue(a));
  const top = rows.slice(0, 6).map((item, index) => `${index + 1}. ${item.client_name} — ${money.format(saleValue(item))} — última atualização ${dateFmt.format(new Date(item.updated_at))}`);
  return { text: `Encontrei ${rows.length} oportunidade(s) aberta(s) com valor. As maiores são:\n\n${top.join('\n')}`, actions: [{ label: 'Ver oportunidades', view: 'followup', tab: 'active' }] };
}

function extractQuotedOrAfter(message: string, triggers: string[]) {
  const quoted = message.match(/[“\"']([^”\"']+)[”\"']/)?.[1]?.trim();
  if (quoted) return quoted;
  const normalized = fold(message);
  for (const trigger of triggers) {
    const index = normalized.indexOf(trigger);
    if (index >= 0) {
      const rawIndex = message.toLowerCase().indexOf(trigger);
      if (rawIndex >= 0) return message.slice(rawIndex + trigger.length).replace(/^[\s:,-]+/, '').trim();
    }
  }
  return '';
}

async function clientSummary(message: string): Promise<ArIAReply> {
  let term = extractQuotedOrAfter(message, ['cliente ', 'da ', 'do ']);
  term = term.replace(/[?.!]+$/, '').trim();
  if (term.length < 3) return { text: 'Me diga o nome do cliente. Exemplo: “ArIA, o que aconteceu da última vez com a PONTUAL BIOENERGIA?”' };
  const pattern = `%${term}%`;
  const [{ data: clientRows }, { data: historyRows }] = await Promise.all([
    supabase.from('g4_client_summary').select('client_name,branch,city,last_service_at,service_count,machine_count,last_operation_type,last_description').ilike('client_name', pattern).order('last_service_at', { ascending: false }).limit(5),
    supabase.from('g4_history_app').select('client_name,serial,city,branch,operation_type,service_date,description').ilike('client_name', pattern).order('service_date', { ascending: false }).limit(5),
  ]);
  const client = (clientRows || [])[0] as any;
  const history = (historyRows || [])[0] as HistoryRow | undefined;
  if (!client) return { text: `Não encontrei cliente correspondente a “${term}” no resumo G4.` };
  const lastDate = history?.service_date || client.last_service_at;
  const description = history?.description || client.last_description || 'Sem descrição registrada no G4';
  const serial = history?.serial ? `\nMáquina: ${history.serial}` : '';
  return {
    text: `Resumo de ${client.client_name}:\n\n${client.city || 'Cidade não informada'} · filial ${client.branch}\n${client.machine_count} máquina(s) · ${client.service_count} OS\nÚltimo atendimento: ${lastDate ? dateFmt.format(new Date(lastDate)) : 'não informado'}\nFaixa de retenção: ${retentionLabel(lastDate || null)}${serial}\nO que foi feito: ${description}`,
    actions: [{ label: 'Abrir Retenção', view: 'retencao' }, { label: 'Ver mapa', view: 'retencao', mode: 'map' }],
  };
}

async function technicianAgenda(message: string): Promise<ArIAReply> {
  let term = extractQuotedOrAfter(message, ['tecnico ', 'técnico ', 'do ', 'da ']);
  term = term.replace(/\b(hoje|amanha|amanhã|essa semana|esta semana|semana)\b.*$/i, '').replace(/[?.!]+$/, '').trim();
  if (term.length < 2) return { text: 'Me diga o nome do técnico. Exemplo: “ArIA, qual a agenda do Almivar?”' };
  const { data: techs } = await supabase.from('technicians').select('id,name,branch').ilike('name', `%${term}%`).eq('active', true).limit(3);
  const tech = (techs || [])[0] as any;
  if (!tech) return { text: `Não encontrei técnico ativo correspondente a “${term}”.` };
  const today = new Date();
  const end = new Date(today); end.setDate(today.getDate() + 14);
  const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const { data } = await supabase.from('appointments').select('appointment_date,client_name,service_city,service_reason,equipment_serial').eq('technician_id', tech.id).gte('appointment_date', toIso(today)).lte('appointment_date', toIso(end)).order('appointment_date').limit(12);
  const rows = data || [];
  if (!rows.length) return { text: `${tech.name} não possui atendimentos nos próximos 14 dias.`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }] };
  const list = rows.map((item: any, index: number) => `${index + 1}. ${dateFmt.format(new Date(`${item.appointment_date}T12:00:00`))} — ${item.client_name || 'Cliente não informado'}${item.service_city ? ` · ${item.service_city}` : ''}${item.service_reason ? ` · ${item.service_reason}` : ''}`);
  return { text: `${tech.name} · ${tech.branch}\nPróximos atendimentos:\n\n${list.join('\n')}`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }, { label: 'Ver rota no mapa', view: 'retencao', mode: 'map' }] };
}

async function retentionCity(message: string): Promise<ArIAReply> {
  let city = extractQuotedOrAfter(message, ['em ', 'de ']);
  city = city.replace(/\b(sem atendimento|retencao|retenção|clientes|ha mais tempo|há mais tempo).*$/i, '').replace(/[?.!]+$/, '').trim();
  if (city.length < 2) return { text: 'Me diga a cidade. Exemplo: “ArIA, quem está há mais tempo sem atendimento em Marabá?”' };
  const { data, error } = await supabase.from('g4_client_city_summary').select('client_name,branch,city,last_service_at,service_count,machine_count').ilike('city', `%${city}%`).order('last_service_at', { ascending: true }).limit(12);
  if (error) return { text: 'Não consegui consultar a Retenção por cidade agora.' };
  const rows = data || [];
  if (!rows.length) return { text: `Não encontrei clientes na Retenção para “${city}”.` };
  const list = rows.slice(0, 6).map((item: any, index: number) => `${index + 1}. ${item.client_name} — ${item.last_service_at ? dateFmt.format(new Date(item.last_service_at)) : 'sem data'} — ${retentionLabel(item.last_service_at)} — ${item.service_count} OS`);
  return { text: `Clientes há mais tempo sem atendimento em ${rows[0].city}:\n\n${list.join('\n')}\n\nA faixa exibida é a mesma classificação usada na tela de Retenção.`, actions: [{ label: 'Abrir Retenção', view: 'retencao' }, { label: 'Ver no mapa', view: 'retencao', mode: 'map' }] };
}

export async function answerArIA(message: string, user: AppUser): Promise<ArIAReply> {
  const text = fold(message);

  if (!text) return { text: 'Pode falar comigo.' };
  if (text.includes('tutorial')) return { text: 'Claro. Vou abrir o tutorial novamente.', actions: [{ label: 'Iniciar tutorial', tutorial: true }] };
  if (/o que (voce|vc) (faz|consegue)|como (voce|vc) pode ajudar|suas funcoes|suas funções|capacidade|capacidades|me ajude/.test(text)) return capabilities();
  if (/quem.*(ligar|contatar|contactar)|contatos?.*hoje|follow.?up.*hoje|retorno.*hoje|atrasad/.test(text)) return followupsToday(user);
  if (/oportunidade|proposta.*sem retorno|valor.*follow|venda.*andamento/.test(text)) return opportunities(user);
  if (/agenda.*tecnico|agenda.*técnico|onde.*(almivar|cezaro|frank|tecnico|técnico)|proximos agendamentos.*(de|do)/.test(text)) return technicianAgenda(message);
  if (/o que aconteceu|ultima vez|última vez|historico.*cliente|histórico.*cliente|resumo.*cliente|me prepare.*cliente/.test(text)) return clientSummary(message);
  if (/mais tempo sem atendimento|retencao.*(em|de)|retenção.*(em|de)|clientes.*(em|de).*(meses|atendimento)/.test(text)) return retentionCity(message);
  if (/abrir.*agenda|ir.*agenda/.test(text)) return { text: 'Abrindo a Agenda.', actions: [{ label: 'Abrir Agenda', view: 'agenda' }] };
  if (/abrir.*retenc|ir.*retenc/.test(text)) return { text: 'Abrindo a Retenção.', actions: [{ label: 'Abrir Retenção', view: 'retencao' }] };
  if (/abrir.*mapa|ver.*mapa/.test(text)) return { text: 'Abrindo o mapa de Retenção.', actions: [{ label: 'Abrir mapa', view: 'retencao', mode: 'map' }] };
  if (/abrir.*follow|ir.*follow/.test(text)) return { text: 'Abrindo o Follow-up.', actions: [{ label: 'Abrir Follow-up', view: 'followup' }] };

  return {
    text: `Eu ainda não interpretei esse pedido com segurança. Posso consultar Agenda, Retenção, histórico G4 e Follow-up sem inventar dados. Você pode tentar algo como:\n\n“Quem eu devo contatar hoje?”\n“Quais oportunidades estão abertas?”\n“Qual a agenda do Almivar?”\n“O que aconteceu da última vez com o cliente X?”\n“Quem está há mais tempo sem atendimento em Marabá?”\n“O que você consegue fazer?”`,
    actions: [{ label: 'Ver minhas capacidades', view: 'inicio' }],
  };
}
