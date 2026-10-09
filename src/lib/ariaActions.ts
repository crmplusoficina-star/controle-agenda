import { supabase } from './supabase';
import type { AppUser } from '../session';
import type { ArIAAction, ArIAReply } from './ariaBrain';
import { effectiveCity } from '../features/ServiceProgramsView';

type Tech = { id: string; name: string; branch: string; active: boolean };
type Machine = { serial: string; client: string; city: string; branch: string; label: string };

export type ArIAFlow =
  | { kind: 'tech_branch'; step: 'tech' | 'branch' | 'confirm'; tech?: Tech; toBranch?: string }
  | { kind: 'schedule'; step: 'machine' | 'tech' | 'date' | 'confirm'; reason: string; machine?: Machine; tech?: Tech; date?: string };

export type FlowReply = ArIAReply & { flow: ArIAFlow | null };

const dateFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
const WEEKDAYS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

function fold(value?: string | null) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function iso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function brDate(value: string) {
  return dateFmt.format(new Date(`${value}T12:00:00`));
}

const choice = (label: string, value = label): ArIAAction => ({ label, choice: value });
const CONFIRM: ArIAAction[] = [{ label: 'Confirmar', choice: '__confirm' }, { label: 'Cancelar', choice: '__cancel' }];

async function loadTechnicians(): Promise<Tech[]> {
  const { data } = await supabase.from('technicians').select('id,name,branch,active').eq('active', true).order('name');
  return (data || []) as Tech[];
}

async function loadActiveBranches(): Promise<string[]> {
  const { data } = await supabase.from('app_branches').select('name').eq('active', true).order('name');
  return (data || []).map((row) => String(row.name));
}

function techInText(message: string, techs: Tech[]) {
  const text = ` ${fold(message)} `;
  return techs.find((tech) => text.includes(` ${fold(tech.name)} `))
    || techs.find((tech) => fold(tech.name).split(/\s+/).some((part) => part.length >= 4 && text.includes(` ${part} `)));
}

function serialInText(message: string) {
  const match = message.toUpperCase().match(/\b[A-Z]{2,5}[A-Z0-9]{8,16}\b/);
  return match ? match[0] : '';
}

function parseDate(input: string) {
  const text = fold(input);
  const today = new Date();
  if (/\bhoje\b/.test(text)) return iso(today);
  if (/\bamanha\b/.test(text)) { const d = new Date(today); d.setDate(d.getDate() + 1); return iso(d); }
  const m = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : today.getFullYear();
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
    if (!Number.isNaN(d.getTime())) return iso(d);
  }
  const dayIndex = WEEKDAYS.findIndex((day) => text.includes(day));
  if (dayIndex >= 0) {
    const d = new Date(today);
    const diff = (dayIndex - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return iso(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  return '';
}

function nextWorkdays(count: number) {
  const out: string[] = [];
  const d = new Date();
  while (out.length < count) {
    if (d.getDay() !== 0) out.push(iso(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

async function machineBySerial(serial: string): Promise<Machine | null> {
  const [{ data: insp }, { data: summary }] = await Promise.all([
    supabase.from('inspection_150h').select('pin,branch,client_name,city,service_city').eq('pin', serial).maybeSingle(),
    supabase.from('g4_machine_summary').select('serial,client_name,city,branch').eq('serial', serial).maybeSingle(),
  ]);
  const row: any = insp || summary;
  if (!row) return null;
  const city = insp ? effectiveCity({ branch: insp.branch, city: insp.city, service_city: insp.service_city }) : (summary?.city || '');
  return { serial, client: row.client_name || '', city: city || '', branch: row.branch || '', label: `${row.client_name || serial} · ${serial}` };
}

async function pendingMachines(reason: string, branches: string[]): Promise<Machine[]> {
  if (reason === 'Visita 150h') {
    let q = supabase.from('inspection_150h').select('pin,branch,client_name,city,service_city,delivery_date').is('executed_date', null).is('programmed_date', null).order('delivery_date').limit(8);
    if (branches.length) q = q.in('branch', branches);
    const { data } = await q;
    return (data || []).map((row: any) => ({ serial: row.pin, client: row.client_name || '', city: effectiveCity(row), branch: row.branch, label: `${row.client_name || row.pin} · …${String(row.pin).slice(-6)} · ${row.branch}` }));
  }
  let q = supabase.from('campaign_machines').select('campaign_code,pin,serial_number,model,branch,client_name,city,service_city').is('executed_date', null).is('programmed_date', null).not('pin', 'is', null).order('repair_deadline').limit(8);
  if (branches.length) q = q.in('branch', branches);
  const { data } = await q;
  return (data || []).map((row: any) => ({ serial: row.pin, client: row.client_name || '', city: effectiveCity(row), branch: row.branch, label: `${row.campaign_code} · ${row.client_name || 'Cliente a validar'} · ${row.model}-${row.serial_number}` }));
}

function reasonFromText(text: string) {
  if (/150 ?h|cento e cinquenta/.test(text)) return 'Visita 150h';
  if (/campanha/.test(text)) return 'Campanha de campo';
  return '';
}

// ---------- Trocar filial do técnico ----------

async function askTechBranch(flow: Extract<ArIAFlow, { kind: 'tech_branch' }>): Promise<FlowReply> {
  if (!flow.tech) {
    const techs = await loadTechnicians();
    return { text: 'Claro. De qual técnico você quer trocar a filial?', actions: techs.slice(0, 20).map((t) => choice(`${t.name} · ${t.branch}`, t.id)), flow: { ...flow, step: 'tech' } };
  }
  if (!flow.toBranch) {
    const branches = (await loadActiveBranches()).filter((b) => b !== flow.tech!.branch);
    return { text: `Claro. Para qual filial você quer associar o técnico ${flow.tech.name}? Hoje ele está em ${flow.tech.branch}.`, actions: branches.map((b) => choice(b)), flow: { ...flow, step: 'branch' } };
  }
  return { text: `Confirma a troca de ${flow.tech.name} de ${flow.tech.branch} para ${flow.toBranch}? Os atendimentos já agendados continuam registrados na filial em que foram criados.`, actions: CONFIRM, flow: { ...flow, step: 'confirm' } };
}

async function runTechBranch(flow: Extract<ArIAFlow, { kind: 'tech_branch' }>): Promise<FlowReply> {
  const { error } = await supabase.from('technicians').update({ branch: flow.toBranch }).eq('id', flow.tech!.id);
  if (error) return { text: `Não consegui trocar a filial: ${error.message}`, flow: null };
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  return { text: `Pronto. ${flow.tech!.name} agora está na filial ${flow.toBranch}.`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }], flow: null };
}

// ---------- Agendar ----------

async function askSchedule(flow: Extract<ArIAFlow, { kind: 'schedule' }>, user: AppUser, userBranches: string[]): Promise<FlowReply> {
  if (!flow.machine) {
    if (flow.reason === 'Visita 150h' || flow.reason === 'Campanha de campo') {
      const options = await pendingMachines(flow.reason, userBranches);
      if (!options.length) return { text: `Não encontrei máquinas com ${flow.reason} pendente de programação nas suas filiais. Se quiser, digite o PIN da máquina.`, flow: { ...flow, step: 'machine' } };
      return { text: `Qual máquina? Estas estão com ${flow.reason === 'Visita 150h' ? 'Visita 150h' : 'campanha'} pendente de programação (digite o PIN se for outra):`, actions: options.map((m) => choice(m.label, m.serial)), flow: { ...flow, step: 'machine' } };
    }
    return { text: 'Qual a série (PIN) da máquina?', flow: { ...flow, step: 'machine' } };
  }
  if (!flow.tech) {
    const techs = await loadTechnicians();
    const sameBranch = techs.filter((t) => t.branch === flow.machine!.branch);
    const list = (sameBranch.length ? sameBranch : techs).slice(0, 12);
    return { text: `Qual técnico vai atender ${flow.machine.client || flow.machine.serial}${flow.machine.city ? ` em ${flow.machine.city}` : ''}?`, actions: list.map((t) => choice(`${t.name} · ${t.branch}`, t.id)), flow: { ...flow, step: 'tech' } };
  }
  if (!flow.date) {
    const { data } = await supabase.from('appointments').select('appointment_date').eq('technician_id', flow.tech.id).gte('appointment_date', iso(new Date())).limit(100);
    const busy = new Set((data || []).map((row: any) => row.appointment_date));
    const days = nextWorkdays(6);
    return {
      text: `Para qual dia? Os dias marcados com ✓ estão livres na agenda de ${flow.tech.name}. Também pode digitar (ex.: 15/10, sexta).`,
      actions: days.map((d) => choice(`${busy.has(d) ? '' : '✓ '}${brDate(d)}`, d)),
      flow: { ...flow, step: 'date' },
    };
  }
  return {
    text: `Confirma o agendamento?\n\n• ${flow.reason}\n• ${flow.machine.client || 'Cliente não informado'} · ${flow.machine.serial}\n• Cidade: ${flow.machine.city || 'não informada'}\n• Técnico: ${flow.tech.name} (${flow.tech.branch})\n• Data: ${brDate(flow.date)}`,
    actions: CONFIRM,
    flow: { ...flow, step: 'confirm' },
  };
}

async function runSchedule(flow: Extract<ArIAFlow, { kind: 'schedule' }>): Promise<FlowReply> {
  const { error } = await supabase.from('appointments').insert({
    branch: flow.tech!.branch,
    appointment_date: flow.date,
    technician_id: flow.tech!.id,
    client_name: flow.machine!.client || null,
    equipment_serial: flow.machine!.serial,
    service_city: flow.machine!.city || null,
    service_reason: flow.reason,
    description: `Agendado pela ArIA`,
  });
  if (error) return { text: `Não consegui criar o agendamento: ${error.message}`, flow: null };
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  const extra = flow.reason === 'Visita 150h' || flow.reason === 'Campanha de campo' ? ' A data de programação já foi preenchida na tela de pendências.' : '';
  return { text: `Pronto. ${flow.reason} agendada para ${flow.tech!.name} em ${brDate(flow.date!)}.${extra}`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }], flow: null };
}

// ---------- Insights reais ----------

async function routeOpportunities(tech: Tech): Promise<FlowReply> {
  const today = new Date();
  const end = new Date(today); end.setDate(today.getDate() + 14);
  const { data: agenda } = await supabase.from('appointments').select('appointment_date,service_city').eq('technician_id', tech.id).gte('appointment_date', iso(today)).lte('appointment_date', iso(end));
  const cities = new Map<string, string>();
  for (const row of agenda || []) if (row.service_city) cities.set(fold(row.service_city), row.service_city);
  if (!cities.size) return { text: `${tech.name} não tem atendimentos com cidade informada nos próximos 14 dias, então não consigo cruzar a rota com as pendências.`, flow: null };

  const [{ data: insp }, { data: camp }] = await Promise.all([
    supabase.from('inspection_150h').select('pin,branch,client_name,city,service_city').is('executed_date', null).limit(2000),
    supabase.from('campaign_machines').select('campaign_code,pin,model,serial_number,branch,client_name,city,service_city').is('executed_date', null).limit(2000),
  ]);
  const hits: { text: string; serial: string; reason: string }[] = [];
  for (const row of insp || []) {
    const city = effectiveCity(row);
    if (city && cities.has(fold(city))) hits.push({ text: `Visita 150h · ${row.client_name || row.pin} (${city})`, serial: row.pin, reason: 'Visita 150h' });
  }
  for (const row of camp || []) {
    const city = effectiveCity(row);
    if (city && cities.has(fold(city))) hits.push({ text: `Campanha ${row.campaign_code} · ${row.client_name || `${row.model}-${row.serial_number}`} (${city})`, serial: row.pin || '', reason: 'Campanha de campo' });
  }
  const cityList = Array.from(cities.values()).join(', ');
  if (!hits.length) return { text: `${tech.name} passa por ${cityList} nos próximos 14 dias. Não há campanha nem Visita 150h pendente nessas cidades.`, flow: null };
  return {
    text: `${tech.name} passa por ${cityList} nos próximos 14 dias. Dá para aproveitar a viagem:\n\n${hits.slice(0, 10).map((h, i) => `${i + 1}. ${h.text}`).join('\n')}${hits.length > 10 ? `\n… e mais ${hits.length - 10}.` : ''}\n\nQuer agendar alguma? Toque na máquina.`,
    actions: hits.filter((h) => h.serial).slice(0, 6).map((h) => ({ label: `Agendar ${h.text.split(' · ')[1]?.split(' (')[0] || h.serial}`, choice: `__schedule|${h.reason}|${h.serial}|${tech.id}` })),
    flow: null,
  };
}

async function branchPendencies(branches: string[], label: string): Promise<FlowReply> {
  const [{ data: insp }, { data: camp }] = await Promise.all([
    supabase.from('inspection_150h').select('programmed_date,executed_date,branch').in('branch', branches).is('executed_date', null),
    supabase.from('campaign_machines').select('programmed_date,executed_date,branch,repair_deadline,recommendation').in('branch', branches).is('executed_date', null),
  ]);
  const i = insp || []; const c = camp || [];
  const iNoProg = i.filter((r: any) => !r.programmed_date).length;
  const cNoProg = c.filter((r: any) => !r.programmed_date).length;
  const mandatory = c.filter((r: any) => r.recommendation === 'Mandatory').length;
  return {
    text: `Pendências ${label}:\n\n• Visita 150h: ${i.length} em aberto (${iNoProg} sem programação)\n• Campanhas: ${c.length} em aberto (${cNoProg} sem programação${mandatory ? `, ${mandatory} obrigatórias` : ''})\n\nQuer que eu agende alguma?`,
    actions: [
      { label: 'Agendar Visita 150h', choice: '__schedule|Visita 150h||' },
      { label: 'Agendar campanha', choice: '__schedule|Campanha de campo||' },
    ],
    flow: null,
  };
}

// ---------- Entrada ----------

export async function startArIAFlow(message: string, user: AppUser, userBranches: string[]): Promise<FlowReply | null> {
  const text = fold(message);

  if (/(troc|mud|transfer|mov|alter|passa)\w*.*filial|filial.*(do|da) tecnic/.test(text)) {
    const techs = await loadTechnicians();
    const tech = techInText(message, techs);
    const branches = await loadActiveBranches();
    const toBranch = branches.find((b) => text.includes(` ${fold(b)}`) && b !== tech?.branch);
    return askTechBranch({ kind: 'tech_branch', step: 'tech', tech, toBranch });
  }

  if (/(aproveit|oportunidad|pendenc|campanha|150 ?h).*(rota|viagem|semana|tecnico)|(rota|viagem).*(aproveit|oportunidad|pendenc)/.test(text)) {
    const techs = await loadTechnicians();
    const tech = techInText(message, techs);
    if (tech) return routeOpportunities(tech);
  }

  if (/pendenc|o que (tem|ha) (de|pra|para) (fazer|programar)|resumo.*(campanha|150)/.test(text)) {
    const branches = await loadActiveBranches();
    const named = branches.filter((b) => text.includes(fold(b)));
    const scope = named.length ? named : userBranches.length ? userBranches : branches;
    return branchPendencies(scope, named.length ? `de ${named.join(', ')}` : 'das suas filiais');
  }

  if (/\b(agend|marc|program)\w*/.test(text) && !/\b(como|onde|qual|quais)\b/.test(text)) {
    const reason = reasonFromText(text) || 'Revisão OS cliente';
    const serial = serialInText(message);
    const machine = serial ? await machineBySerial(serial) : null;
    const techs = await loadTechnicians();
    const tech = techInText(message, techs);
    const date = parseDate(message);
    const flow: Extract<ArIAFlow, { kind: 'schedule' }> = { kind: 'schedule', step: 'machine', reason, machine: machine || (serial ? { serial, client: '', city: '', branch: '', label: serial } : undefined), tech, date: date || undefined };
    return askSchedule(flow, user, userBranches);
  }

  return null;
}

export async function continueArIAFlow(flow: ArIAFlow | null, input: string, user: AppUser, userBranches: string[]): Promise<FlowReply | null> {
  if (input.startsWith('__schedule|')) {
    const [, reason, serial, techId] = input.split('|');
    const techs = await loadTechnicians();
    const machine = serial ? await machineBySerial(serial) : null;
    return askSchedule({ kind: 'schedule', step: 'machine', reason, machine: machine || undefined, tech: techs.find((t) => t.id === techId) }, user, userBranches);
  }
  if (!flow) return null;
  const text = fold(input);
  if (input === '__cancel' || /^(cancela|cancelar|nao|desisto|esquece)\b/.test(text)) return { text: 'Tudo bem, cancelei. Nada foi alterado.', flow: null };

  if (flow.kind === 'tech_branch') {
    if (flow.step === 'tech') {
      const techs = await loadTechnicians();
      const tech = techs.find((t) => t.id === input) || techInText(input, techs);
      if (!tech) return { text: 'Não encontrei esse técnico. Escolha uma das opções acima ou digite o nome.', flow };
      return askTechBranch({ ...flow, tech });
    }
    if (flow.step === 'branch') {
      const branches = await loadActiveBranches();
      const toBranch = branches.find((b) => fold(b) === text) || branches.find((b) => text.includes(fold(b)));
      if (!toBranch) return { text: 'Não reconheci essa filial. Escolha uma das opções acima.', flow };
      return askTechBranch({ ...flow, toBranch });
    }
    if (input === '__confirm' || /^(sim|confirm|pode|ok)/.test(text)) return runTechBranch(flow);
    return null;
  }

  if (flow.step === 'machine') {
    const serial = serialInText(input) || input.toUpperCase().trim();
    const machine = await machineBySerial(serial);
    if (!machine) return { text: `Não encontrei a máquina ${serial} no G4. Confira o PIN ou escolha uma das opções.`, flow };
    return askSchedule({ ...flow, machine }, user, userBranches);
  }
  if (flow.step === 'tech') {
    const techs = await loadTechnicians();
    const tech = techs.find((t) => t.id === input) || techInText(input, techs);
    if (!tech) return { text: 'Não encontrei esse técnico. Escolha uma das opções ou digite o nome.', flow };
    return askSchedule({ ...flow, tech }, user, userBranches);
  }
  if (flow.step === 'date') {
    const date = parseDate(input);
    if (!date) return { text: 'Não entendi a data. Escolha uma opção ou digite como 15/10 ou "sexta".', flow };
    return askSchedule({ ...flow, date }, user, userBranches);
  }
  if (input === '__confirm' || /^(sim|confirm|pode|ok)/.test(text)) return runSchedule(flow);
  return null;
}
