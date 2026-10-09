import { supabase } from './supabase';
import type { AppUser } from '../session';
import type { ArIAAction, ArIAReply } from './ariaBrain';
import { effectiveCity } from '../features/ServiceProgramsView';
import { INTENT_LABELS, extractDates as extractDatesAll, interpret, learnIntent, type NluIntent } from './ariaNlu';
import { isCityProspectIntent } from './ariaSmart';

type Tech = { id: string; name: string; branch: string; active: boolean };
type Machine = { serial: string; client: string; city: string; branch: string; label: string };

export type ArIAFlow =
  | { kind: 'tech_branch'; step: 'tech' | 'branch' | 'confirm'; tech?: Tech; toBranch?: string }
  | { kind: 'schedule'; step: 'machine' | 'tech' | 'date' | 'confirm'; reason: string; machine?: Machine; tech?: Tech; date?: string }
  | { kind: 'appt'; op: 'reschedule' | 'complete' | 'delete'; step: 'pick' | 'date' | 'confirm'; candidates?: Appt[]; appt?: Appt; newDate?: string; newTech?: Tech }
  | { kind: 'tech_add'; step: 'name' | 'branch' | 'confirm'; name?: string; branch?: string }
  | { kind: 'tech_off'; step: 'tech' | 'confirm'; tech?: Tech }
  | { kind: 'followup'; step: 'client' | 'confirm'; client?: string; branch?: string; notes?: string; date?: string; candidates?: { client: string; branch: string }[] }
  | { kind: 'machine_city'; step: 'pin' | 'city' | 'confirm'; pin?: string; city?: string }
  | { kind: 'undo'; step: 'confirm' }
  | { kind: 'bill'; step: 'pick' | 'confirm'; candidates?: Appt[]; appt?: Appt }
  | { kind: 'hourmeter'; step: 'pick' | 'hours' | 'confirm'; pin?: string; hours?: number; candidates?: Appt[]; appt?: Appt }
  | { kind: 'contact'; step: 'client' | 'phone' | 'confirm'; client?: string; branch?: string; phone?: string; candidates?: { client: string; branch: string }[] }
  | { kind: 'leave'; step: 'tech' | 'start' | 'confirm'; tech?: Tech; reason: string; start?: string; end?: string }
  | { kind: 'move_day'; step: 'from' | 'to' | 'confirm'; from?: Tech; to?: Tech; date: string; ids?: string[] }
  | { kind: 'note'; step: 'pick' | 'text' | 'confirm'; candidates?: Appt[]; appt?: Appt; text?: string };

type Appt = { id: string; appointment_date: string; client_name: string | null; equipment_serial: string | null; service_city: string | null; service_reason: string | null; technician_id: string; branch: string; techName: string };

export type FlowReply = ArIAReply & { flow: ArIAFlow | null };

// Memória curta da conversa: último técnico citado e a última ação desfazível.
const memory = { tech: '' };
let lastUndo: { label: string; run: () => Promise<string | null> } | null = null;

function remember(techName?: string) {
  if (techName) memory.tech = techName;
}

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
  const match = message.toUpperCase().match(/\b(?=[A-Z0-9]*\d{4})[A-Z]{2,5}[A-Z0-9]{8,16}\b/);
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
  const tech = flow.tech!;
  remember(tech.name);
  lastUndo = { label: `devolver ${tech.name} para ${tech.branch}`, run: async () => (await supabase.from('technicians').update({ branch: tech.branch }).eq('id', tech.id)).error?.message || null };
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  return { text: `Pronto. ${flow.tech!.name} agora está na filial ${flow.toBranch}.`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }], flow: null };
}

// ---------- Agendar ----------

async function askSchedule(flow: Extract<ArIAFlow, { kind: 'schedule' }>, user: AppUser, userBranches: string[]): Promise<FlowReply> {
  if (!flow.machine) {
    if (flow.reason === 'Visita 150h' || flow.reason === 'Campanha de campo') {
      const own = flow.tech ? await pendingMachines(flow.reason, [flow.tech.branch]) : [];
      const options = own.length ? own : await pendingMachines(flow.reason, userBranches);
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
  const { data: created, error } = await supabase.from('appointments').insert({
    branch: flow.tech!.branch,
    appointment_date: flow.date,
    technician_id: flow.tech!.id,
    client_name: flow.machine!.client || null,
    equipment_serial: flow.machine!.serial,
    service_city: flow.machine!.city || null,
    service_reason: flow.reason,
    description: `Agendado pela ArIA`,
  }).select('id').single();
  if (error) return { text: `Não consegui criar o agendamento: ${error.message}`, flow: null };
  remember(flow.tech!.name);
  const createdId = (created as any)?.id;
  lastUndo = createdId ? { label: `apagar o agendamento criado (${flow.reason}, ${brDate(flow.date!)})`, run: async () => (await supabase.from('appointments').delete().eq('id', createdId)).error?.message || null } : null;
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

// ---------- Atendimentos existentes: remarcar, concluir, excluir ----------

async function findAppointments(techs: Tech[], tech?: Tech, term?: string, date?: string, past = false): Promise<Appt[]> {
  let q = supabase.from('appointments').select('id,appointment_date,client_name,equipment_serial,service_city,service_reason,technician_id,branch').order('appointment_date', { ascending: !past }).limit(8);
  if (date) q = q.eq('appointment_date', date);
  else if (past) { const from = new Date(); from.setDate(from.getDate() - 14); q = q.gte('appointment_date', iso(from)).lte('appointment_date', iso(new Date())); }
  else q = q.gte('appointment_date', iso(new Date()));
  if (tech) q = q.eq('technician_id', tech.id);
  const clean = (term || '').trim();
  if (clean) q = q.or(`client_name.ilike.%${clean.replace(/[%,()]/g, ' ')}%,equipment_serial.ilike.%${clean.replace(/[%,()]/g, ' ')}%`);
  const { data } = await q;
  const names = new Map(techs.map((t) => [t.id, t.name]));
  return (data || []).map((row: any) => ({ ...row, techName: names.get(row.technician_id) || 'Técnico' }));
}

const apptLabel = (a: Appt) => `${brDate(a.appointment_date)} · ${a.techName} · ${a.client_name || a.service_reason || 'Atendimento'}`;
const OP_LABEL = { reschedule: 'remarcar', complete: 'concluir', delete: 'excluir' } as const;

async function askAppt(flow: Extract<ArIAFlow, { kind: 'appt' }>): Promise<FlowReply> {
  if (!flow.appt) {
    const list = flow.candidates || [];
    if (!list.length) return { text: `Não encontrei atendimento para ${OP_LABEL[flow.op]} com esses dados. Diga o técnico, o cliente ou a data.`, flow: null };
    if (list.length > 1) return { text: `Qual atendimento você quer ${OP_LABEL[flow.op]}?`, actions: list.map((a) => choice(apptLabel(a), a.id)), flow: { ...flow, step: 'pick' } };
    return askAppt({ ...flow, appt: list[0] });
  }
  if (flow.op === 'reschedule' && !flow.newDate && !flow.newTech) {
    return { text: `Para qual dia você quer remarcar ${apptLabel(flow.appt)}? Pode digitar (ex.: 15/10, sexta).`, actions: nextWorkdays(6).map((d) => choice(brDate(d), d)), flow: { ...flow, step: 'date' } };
  }
  const a = flow.appt;
  const detail = flow.op === 'reschedule'
    ? `Remarcar ${apptLabel(a)} para ${flow.newDate ? brDate(flow.newDate) : brDate(a.appointment_date)}${flow.newTech ? ` com ${flow.newTech.name}` : ''}?`
    : flow.op === 'complete' ? `Marcar como concluído: ${apptLabel(a)}?${a.service_reason === 'Visita 150h' || a.service_reason === 'Campanha de campo' ? ' A data de execução será preenchida na tela de pendências.' : ''}`
      : `Excluir o atendimento ${apptLabel(a)}? Essa ação não pode ser desfeita.`;
  return { text: detail, actions: CONFIRM, flow: { ...flow, step: 'confirm' } };
}

async function runAppt(flow: Extract<ArIAFlow, { kind: 'appt' }>): Promise<FlowReply> {
  const a = flow.appt!;
  let error;
  if (flow.op === 'reschedule') {
    const patch: Record<string, unknown> = {};
    if (flow.newDate) patch.appointment_date = flow.newDate;
    if (flow.newTech) { patch.technician_id = flow.newTech.id; patch.branch = flow.newTech.branch; }
    ({ error } = await supabase.from('appointments').update(patch).eq('id', a.id));
  } else if (flow.op === 'complete') {
    ({ error } = await supabase.from('appointments').update({ status: 'concluido' }).eq('id', a.id));
  } else {
    ({ error } = await supabase.from('appointments').delete().eq('id', a.id));
  }
  if (error) return { text: `Não consegui ${OP_LABEL[flow.op]}: ${error.message}`, flow: null };
  remember(a.techName);
  lastUndo = flow.op === 'reschedule'
    ? { label: `voltar o atendimento para ${brDate(a.appointment_date)} com ${a.techName}`, run: async () => (await supabase.from('appointments').update({ appointment_date: a.appointment_date, technician_id: a.technician_id, branch: a.branch }).eq('id', a.id)).error?.message || null }
    : flow.op === 'complete'
      ? { label: `reabrir o atendimento de ${brDate(a.appointment_date)}`, run: async () => (await supabase.from('appointments').update({ status: 'planejado' }).eq('id', a.id)).error?.message || null }
      : null;
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  const done = flow.op === 'reschedule' ? 'remarcado' : flow.op === 'complete' ? 'concluído' : 'excluído';
  return { text: `Pronto. Atendimento ${done}.`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }], flow: null };
}

// ---------- Técnicos: adicionar e desativar ----------

async function askTechAdd(flow: Extract<ArIAFlow, { kind: 'tech_add' }>): Promise<FlowReply> {
  if (!flow.name) return { text: 'Qual o nome do novo técnico?', flow: { ...flow, step: 'name' } };
  if (!flow.branch) return { text: `Em qual filial ${flow.name} vai atender?`, actions: (await loadActiveBranches()).map((b) => choice(b)), flow: { ...flow, step: 'branch' } };
  return { text: `Cadastrar o técnico ${flow.name} na filial ${flow.branch}?`, actions: CONFIRM, flow: { ...flow, step: 'confirm' } };
}

async function runTechAdd(flow: Extract<ArIAFlow, { kind: 'tech_add' }>): Promise<FlowReply> {
  const { data: created, error } = await supabase.from('technicians').insert({ name: flow.name, branch: flow.branch, active: true }).select('id').single();
  if (!error && created) {
    remember(flow.name);
    lastUndo = { label: `remover o cadastro de ${flow.name}`, run: async () => (await supabase.from('technicians').delete().eq('id', (created as any).id)).error?.message || null };
  }
  if (error) return { text: error.code === '23505' ? `Já existe um técnico ${flow.name} em ${flow.branch}.` : `Não consegui cadastrar: ${error.message}`, flow: null };
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  return { text: `Pronto. ${flow.name} foi cadastrado em ${flow.branch}.`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }], flow: null };
}

async function askTechOff(flow: Extract<ArIAFlow, { kind: 'tech_off' }>): Promise<FlowReply> {
  if (!flow.tech) return { text: 'Qual técnico você quer desativar?', actions: (await loadTechnicians()).slice(0, 20).map((t) => choice(`${t.name} · ${t.branch}`, t.id)), flow: { ...flow, step: 'tech' } };
  return { text: `Desativar ${flow.tech.name} (${flow.tech.branch})? Ele sai da agenda, mas o histórico de atendimentos é mantido.`, actions: CONFIRM, flow: { ...flow, step: 'confirm' } };
}

async function runTechOff(flow: Extract<ArIAFlow, { kind: 'tech_off' }>): Promise<FlowReply> {
  const { error } = await supabase.from('technicians').update({ active: false }).eq('id', flow.tech!.id);
  if (error) return { text: `Não consegui desativar: ${error.message}`, flow: null };
  const off = flow.tech!;
  remember(off.name);
  lastUndo = { label: `reativar ${off.name}`, run: async () => (await supabase.from('technicians').update({ active: true }).eq('id', off.id)).error?.message || null };
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  return { text: `Pronto. ${flow.tech!.name} foi desativado.`, flow: null };
}

// ---------- Follow-up ----------

async function askFollowup(flow: Extract<ArIAFlow, { kind: 'followup' }>, userBranches: string[]): Promise<FlowReply> {
  if (!flow.branch) {
    const term = (flow.client || '').trim();
    if (!term) return { text: 'Para qual cliente você quer abrir o follow-up?', flow: { ...flow, step: 'client' } };
    let q = supabase.from('g4_client_summary').select('client_name,branch').ilike('client_name', `%${term}%`).order('last_service_at', { ascending: false }).limit(6);
    if (userBranches.length) q = q.in('branch', userBranches);
    const { data } = await q;
    const found = (data || []).map((row: any) => ({ client: row.client_name, branch: row.branch }));
    if (!found.length) return { text: `Não encontrei "${term}" no histórico G4. Digite o nome como aparece no G4.`, flow: { ...flow, step: 'client', client: '' } };
    if (found.length > 1) return { text: 'Qual destes clientes?', actions: found.map((c, i) => choice(`${c.client} · ${c.branch}`, `__client|${i}`)), flow: { ...flow, step: 'client', candidates: found } };
    flow = { ...flow, client: found[0].client, branch: found[0].branch };
  }
  const { data: open } = await supabase.from('followups').select('id').eq('branch', flow.branch!).ilike('client_name', flow.client!).neq('stage', 'encerrar').limit(1);
  if ((open || []).length) return { text: `${flow.client} já tem uma tratativa aberta no Follow-up.`, actions: [{ label: 'Abrir Follow-up', view: 'followup' }], flow: null };
  return { text: `Abrir follow-up para ${flow.client} (${flow.branch})${flow.date ? ` com retorno em ${brDate(flow.date)}` : ''}${flow.notes ? `\nObservação: ${flow.notes}` : ''}?`, actions: CONFIRM, flow: { ...flow, step: 'confirm' } };
}

async function runFollowup(flow: Extract<ArIAFlow, { kind: 'followup' }>, user: AppUser): Promise<FlowReply> {
  const { data: created, error } = await supabase.from('followups').insert({
    branch: flow.branch, client_name: flow.client, stage: 'prospectar',
    next_followup_date: flow.date || null, notes: flow.notes || 'Aberto pela ArIA',
    created_by_matricula: user.matricula, created_by_name: user.name, updated_by_matricula: user.matricula, updated_by_name: user.name,
  }).select('id').single();
  if (error) return { text: `Não consegui abrir o follow-up: ${error.message}`, flow: null };
  lastUndo = created ? { label: `apagar o follow-up de ${flow.client}`, run: async () => (await supabase.from('followups').delete().eq('id', (created as any).id)).error?.message || null } : null;
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  return { text: `Pronto. Follow-up aberto para ${flow.client}.`, actions: [{ label: 'Abrir Follow-up', view: 'followup' }], flow: null };
}

// ---------- Cidade da máquina (150h / campanha) ----------

async function askMachineCity(flow: Extract<ArIAFlow, { kind: 'machine_city' }>): Promise<FlowReply> {
  if (!flow.pin) return { text: 'Qual o PIN da máquina?', flow: { ...flow, step: 'pin' } };
  if (!flow.city) return { text: `Em qual cidade a máquina ${flow.pin} está?`, flow: { ...flow, step: 'city' } };
  return { text: `Registrar a cidade ${flow.city} para a máquina ${flow.pin} nas telas Visita 150h e Campanhas?`, actions: CONFIRM, flow: { ...flow, step: 'confirm' } };
}

async function runMachineCity(flow: Extract<ArIAFlow, { kind: 'machine_city' }>, user: AppUser): Promise<FlowReply> {
  const [{ data: insp }, { data: camp }] = await Promise.all([
    supabase.from('inspection_150h').select('pin,programmed_date,executed_date,notes').eq('pin', flow.pin!),
    supabase.from('campaign_machines').select('id,programmed_date,executed_date,notes').eq('pin', flow.pin!),
  ]);
  const jobs = [
    ...(insp || []).map((r: any) => supabase.rpc('update_service_program', { p_actor: user.matricula, p_kind: '150h', p_id: r.pin, p_programmed: r.programmed_date, p_executed: r.executed_date, p_notes: r.notes, p_city: flow.city })),
    ...(camp || []).map((r: any) => supabase.rpc('update_service_program', { p_actor: user.matricula, p_kind: 'campanha', p_id: r.id, p_programmed: r.programmed_date, p_executed: r.executed_date, p_notes: r.notes, p_city: flow.city })),
  ];
  if (!jobs.length) return { text: `A máquina ${flow.pin} não está na Visita 150h nem nas campanhas.`, flow: null };
  const results = await Promise.all(jobs);
  const failed = results.find((r) => r.error);
  if (failed?.error) return { text: `Não consegui registrar: ${failed.error.message}`, flow: null };
  return { text: `Pronto. ${flow.pin} agora está em ${flow.city} (${jobs.length} registro${jobs.length > 1 ? 's' : ''}).`, flow: null };
}


// ---------- Pacote do dia a dia ----------

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const NON_SERVICE = ['Folga', 'Férias', 'Sem agenda', 'Treinamento', 'Manutenção carro', 'Retorno à filial'];

function weekRange(base = new Date()) {
  const d = new Date(base);
  const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const saturday = new Date(monday); saturday.setDate(monday.getDate() + 5);
  return [iso(monday), iso(saturday)] as const;
}

function scopeBranches(named: string | undefined, userBranches: string[]) {
  return named ? [named] : userBranches;
}

async function apptsBetween(from: string, to: string, branches: string[], techId?: string) {
  let q = supabase.from('appointments').select('id,appointment_date,client_name,equipment_serial,service_city,service_reason,technician_id,branch,forecast_amount,billing_status,description,status').gte('appointment_date', from).lte('appointment_date', to).order('appointment_date').limit(1000);
  if (branches.length) q = q.in('branch', branches);
  if (techId) q = q.eq('technician_id', techId);
  const { data } = await q;
  return (data || []) as any[];
}

async function agendaDia(day: string, branches: string[], techs: Tech[], label: string): Promise<FlowReply> {
  const all = await apptsBetween(day, day, branches);
  const rows = all.filter((r) => !NON_SERVICE.includes(r.service_reason || ''));
  const off = all.filter((r) => ['Folga', 'Férias'].includes(r.service_reason || ''));
  const names = new Map(techs.map((t) => [t.id, t]));
  const byTech = new Map<string, any[]>();
  for (const r of rows) byTech.set(r.technician_id, [...(byTech.get(r.technician_id) || []), r]);
  const offIds = new Set(off.map((r) => r.technician_id));
  const pool = techs.filter((t) => !branches.length || branches.includes(t.branch));
  const idle = pool.filter((t) => !byTech.has(t.id) && !offIds.has(t.id));
  const offText = off.length ? `\n\nDe folga/férias: ${Array.from(new Set(off.map((r) => names.get(r.technician_id)?.name || 'Técnico'))).join(', ')}.` : '';
  if (!rows.length) return { text: `Não há atendimentos em ${brDate(day)}${label}.${offText}`, actions: [{ label: 'Agendar atendimento', choice: '__say|agendar atendimento' }], flow: null };
  const lines = Array.from(byTech.entries()).map(([id, list]) => `• ${names.get(id)?.name || 'Técnico'}: ${list.map((r) => `${r.client_name || r.service_reason || 'Atendimento'}${r.service_city ? ` (${r.service_city})` : ''}`).join('; ')}`);
  return {
    text: `Agenda de ${brDate(day)}${label}: ${rows.length} atendimento(s) com ${byTech.size} técnico(s).\n\n${lines.slice(0, 15).join('\n')}${lines.length > 15 ? `\n… e mais ${lines.length - 15} técnicos.` : ''}${offText}${idle.length ? `\n\nSem atendimento: ${idle.map((t) => t.name).join(', ')}.` : ''}`,
    actions: [{ label: 'Abrir Agenda', view: 'agenda' }, ...(idle.length ? [{ label: `Agendar ${idle[0].name}`, choice: `__schedule|Revisão OS cliente||${idle[0].id}` }] : [])],
    flow: null,
  };
}

async function ondeTecnico(tech: Tech, day: string): Promise<FlowReply> {
  const rows = await apptsBetween(day, day, [], tech.id);
  if (!rows.length) {
    const next = await apptsBetween(day, iso(new Date(new Date(`${day}T12:00:00`).getTime() + 14 * 86400000)), [], tech.id);
    return { text: `${tech.name} (${tech.branch}) não tem atendimento em ${brDate(day)}.${next[0] ? ` O próximo é em ${brDate(next[0].appointment_date)}: ${next[0].client_name || next[0].service_reason}${next[0].service_city ? ` em ${next[0].service_city}` : ''}.` : ' Também não há nada nos próximos 14 dias.'}`, actions: [{ label: `Agendar ${tech.name}`, choice: `__schedule|Revisão OS cliente||${tech.id}` }], flow: null };
  }
  return { text: `${tech.name} em ${brDate(day)}:\n\n${rows.map((r, i) => `${i + 1}. ${r.service_reason || 'Atendimento'} · ${r.client_name || 'cliente não informado'}${r.service_city ? ` · ${r.service_city}` : ' · cidade não informada'}`).join('\n')}`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }], flow: null };
}

async function cargaSemana(branches: string[], techs: Tech[]): Promise<FlowReply> {
  const [from, to] = weekRange();
  const rows = (await apptsBetween(from, to, branches)).filter((r) => !NON_SERVICE.includes(r.service_reason || ''));
  const pool = techs.filter((t) => !branches.length || branches.includes(t.branch));
  const count = new Map(pool.map((t) => [t.id, 0]));
  for (const r of rows) if (count.has(r.technician_id)) count.set(r.technician_id, (count.get(r.technician_id) || 0) + 1);
  const sorted = pool.map((t) => ({ t, n: count.get(t.id) || 0 })).sort((a, b) => b.n - a.n);
  const avg = sorted.length ? rows.length / sorted.length : 0;
  return {
    text: `Carga da semana (${brDate(from)} a ${brDate(to)}), ${rows.length} atendimento(s), média ${avg.toFixed(1)} por técnico:\n\n${sorted.map(({ t, n }) => `• ${t.name} (${t.branch}): ${n}${n === 0 ? ' — livre' : n > avg * 1.5 && n >= 4 ? ' — carregado' : ''}`).join('\n')}`,
    actions: [{ label: 'Técnicos livres hoje', choice: '__say|quais técnicos estão ociosos hoje' }],
    flow: null,
  };
}

async function faturamento(branches: string[], periodo: string): Promise<FlowReply> {
  const today = new Date();
  const [from, to] = periodo === 'hoje' ? [iso(today), iso(today)] : periodo === 'mes' ? [iso(new Date(today.getFullYear(), today.getMonth(), 1)), iso(new Date(today.getFullYear(), today.getMonth() + 1, 0))] : weekRange();
  const rows = await apptsBetween(from, to, branches);
  const sum = (filter: (r: any) => boolean) => rows.filter(filter).reduce((acc, r) => acc + Number(r.forecast_amount || 0), 0);
  const total = sum(() => true);
  const faturado = sum((r) => r.billing_status === 'faturado');
  const pendente = sum((r) => r.billing_status === 'aguardando_faturamento');
  const semPreco = rows.filter((r) => !Number(r.forecast_amount) && !NON_SERVICE.includes(r.service_reason || '')).length;
  const label = periodo === 'hoje' ? 'hoje' : periodo === 'mes' ? 'no mês' : 'na semana';
  return {
    text: `Faturamento previsto ${label} (${brDate(from)} a ${brDate(to)}): ${money.format(total)}\n\n• Já faturado: ${money.format(faturado)}\n• Pendente de faturamento: ${money.format(pendente)}\n• Sem status: ${money.format(total - faturado - pendente)}${semPreco ? `\n\n${semPreco} atendimento(s) ainda sem valor previsto.` : ''}`,
    actions: [{ label: 'Ver pendentes de faturamento', choice: '__say|o que falta faturar' }],
    flow: null,
  };
}

async function pendentesFaturamento(branches: string[], techs: Tech[]): Promise<FlowReply> {
  const from = new Date(); from.setDate(from.getDate() - 60);
  let q = supabase.from('appointments').select('id,appointment_date,client_name,equipment_serial,service_city,service_reason,technician_id,branch,forecast_amount').eq('billing_status', 'aguardando_faturamento').gte('appointment_date', iso(from)).order('appointment_date').limit(30);
  if (branches.length) q = q.in('branch', branches);
  const { data } = await q;
  const rows = data || [];
  if (!rows.length) return { text: 'Não há atendimentos pendentes de faturamento nos últimos 60 dias.', flow: null };
  const names = new Map(techs.map((t) => [t.id, t.name]));
  const total = rows.reduce((acc: number, r: any) => acc + Number(r.forecast_amount || 0), 0);
  return {
    text: `${rows.length} atendimento(s) pendentes de faturamento (${money.format(total)}):\n\n${rows.slice(0, 12).map((r: any, i: number) => `${i + 1}. ${brDate(r.appointment_date)} · ${names.get(r.technician_id) || 'Técnico'} · ${r.client_name || r.service_reason} · ${money.format(Number(r.forecast_amount || 0))}`).join('\n')}`,
    actions: rows.slice(0, 5).map((r: any) => ({ label: `Faturado: ${r.client_name || r.service_reason} ${brDate(r.appointment_date)}`, choice: `__bill|${r.id}` })),
    flow: null,
  };
}

async function historicoMaquina(pin: string): Promise<FlowReply> {
  const [{ data: summary }, { data: hist }, { data: hour }, { data: insp }, { data: camp }] = await Promise.all([
    supabase.from('g4_machine_summary').select('client_name,city,branch,service_count,last_service_at').eq('serial', pin).maybeSingle(),
    supabase.from('g4_history_app').select('service_date,operation_type,description,status').eq('serial', pin).order('service_date', { ascending: false }).limit(5),
    supabase.from('hourmeter_readings').select('hourmeter,reading_date').eq('equipment_serial', pin).order('reading_date', { ascending: false }).limit(1),
    supabase.from('inspection_150h').select('programmed_date').eq('pin', pin).is('executed_date', null).maybeSingle(),
    supabase.from('campaign_machines').select('campaign_code').eq('pin', pin).is('executed_date', null),
  ]);
  if (!summary && !(hist || []).length) return { text: `Não encontrei a máquina ${pin} no histórico G4 das filiais ativas.`, flow: null };
  const pend = [insp ? 'Visita 150h pendente' : '', ...(camp || []).map((c: any) => `Campanha ${c.campaign_code} pendente`)].filter(Boolean);
  return {
    text: `${pin}${summary ? ` · ${summary.client_name || 'cliente não informado'} · ${summary.city || ''} (${summary.branch})` : ''}\n${summary ? `${summary.service_count} OS no G4.` : ''}${(hour || [])[0] ? ` Último horímetro: ${Number(hour![0].hourmeter).toLocaleString('pt-BR')} h em ${brDate(hour![0].reading_date)}.` : ''}\n\nÚltimos atendimentos:\n${(hist || []).map((h: any) => `• ${h.service_date ? brDate(String(h.service_date).slice(0, 10)) : 's/ data'} · ${h.operation_type || ''}${h.description ? ` · ${String(h.description).slice(0, 70)}` : ''}`).join('\n') || '• sem registros'}${pend.length ? `\n\nPendências: ${pend.join(', ')}.` : ''}`,
    actions: pend.length ? [{ label: 'Agendar pendência', choice: `__schedule|${insp ? 'Visita 150h' : 'Campanha de campo'}|${pin}|` }] : [{ label: 'Agendar atendimento', choice: `__schedule|Revisão OS cliente|${pin}|` }],
    flow: null,
  };
}

async function findClients(term: string, userBranches: string[]) {
  let q = supabase.from('g4_client_summary').select('client_name,branch').ilike('client_name', `%${term.replace(/[%,()]/g, ' ')}%`).order('last_service_at', { ascending: false }).limit(6);
  if (userBranches.length) q = q.in('branch', userBranches);
  const { data } = await q;
  return (data || []).map((row: any) => ({ client: row.client_name as string, branch: row.branch as string }));
}

async function contatoCliente(term: string, userBranches: string[]): Promise<FlowReply> {
  if (!term) return { text: 'De qual cliente você quer o contato?', flow: null };
  const found = await findClients(term, userBranches);
  if (!found.length) return { text: `Não encontrei "${term}" no histórico G4.`, flow: null };
  const c = found[0];
  const [{ data: saved }, { data: g4 }] = await Promise.all([
    supabase.from('client_contacts').select('phone').eq('client_key', `${c.client.trim().toUpperCase()}|${c.branch.trim().toUpperCase()}`).limit(1),
    supabase.from('g4_ordens_servico').select('nome_contato,email_contato,telefones,data_abertura').eq('filial', c.branch).ilike('razao_social', c.client).order('data_abertura', { ascending: false }).limit(5),
  ]);
  const phone = (saved || [])[0]?.phone;
  const g = (g4 || []).find((r: any) => r.nome_contato || r.email_contato || r.telefones);
  return {
    text: `${c.client} (${c.branch})\n\n${phone ? `• Telefone salvo na Agenda: ${phone}\n` : ''}${g?.nome_contato ? `• Contato no G4: ${g.nome_contato}\n` : ''}${g?.telefones ? `• Telefones no G4: ${g.telefones}\n` : ''}${g?.email_contato ? `• E-mail: ${g.email_contato}\n` : ''}${!phone && !g ? 'Não há contato registrado. Me diga o telefone que eu salvo.' : ''}${found.length > 1 ? `\n(Encontrei ${found.length} clientes parecidos; mostrei o mais recente.)` : ''}`,
    actions: phone ? [{ label: 'Abrir WhatsApp', choice: `__wa|${phone}` }] : [],
    flow: null,
  };
}

async function incompletos(branches: string[], techs: Tech[]): Promise<FlowReply> {
  const today = new Date(); const end = new Date(); end.setDate(today.getDate() + 14);
  const rows = (await apptsBetween(iso(today), iso(end), branches)).filter((r) => !NON_SERVICE.includes(r.service_reason || '') && !/^Deslocamento/.test(r.service_reason || ''));
  const noCity = rows.filter((r) => !r.service_city);
  const noClient = rows.filter((r) => !r.client_name);
  const noSerial = rows.filter((r) => !r.equipment_serial);
  const names = new Map(techs.map((t) => [t.id, t.name]));
  if (!noCity.length && !noClient.length) return { text: 'Os atendimentos dos próximos 14 dias estão com cliente e cidade preenchidos.', flow: null };
  return {
    text: `Atendimentos dos próximos 14 dias com cadastro incompleto:\n\n• Sem cidade: ${noCity.length} (a rota e o mapa não funcionam sem ela)\n• Sem cliente: ${noClient.length}\n• Sem série/PIN: ${noSerial.length}\n\n${noCity.slice(0, 8).map((r) => `- ${brDate(r.appointment_date)} · ${names.get(r.technician_id) || 'Técnico'} · ${r.client_name || r.service_reason || 'Atendimento'}`).join('\n')}`,
    actions: [{ label: 'Abrir Agenda', view: 'agenda' }],
    flow: null,
  };
}

async function atrasadas(branches: string[]): Promise<FlowReply> {
  const limit = new Date(); limit.setDate(limit.getDate() - 30);
  const soon = new Date(); soon.setDate(soon.getDate() + 120);
  let qi = supabase.from('inspection_150h').select('pin,client_name,branch,delivery_date').is('programmed_date', null).is('executed_date', null).lte('delivery_date', iso(limit)).order('delivery_date').limit(30);
  let qc = supabase.from('campaign_machines').select('campaign_code,client_name,branch,model,serial_number,repair_deadline,recommendation,pin').is('executed_date', null).lte('repair_deadline', iso(soon)).order('repair_deadline').limit(30);
  if (branches.length) { qi = qi.in('branch', branches); qc = qc.in('branch', branches); }
  const [{ data: i }, { data: c }] = await Promise.all([qi, qc]);
  const insp = i || []; const camp = c || [];
  if (!insp.length && !camp.length) return { text: 'Nada atrasado: nenhuma Visita 150h com ET há mais de 30 dias sem programação e nenhuma campanha com prazo nos próximos 120 dias.', flow: null };
  return {
    text: `${insp.length ? `Visita 150h sem programação há mais de 30 dias da ET (${insp.length}):\n${insp.slice(0, 8).map((r: any) => `• ${r.client_name || r.pin} · ${r.branch} · ET ${brDate(r.delivery_date)}`).join('\n')}\n\n` : ''}${camp.length ? `Campanhas com prazo em até 120 dias (${camp.length}):\n${camp.slice(0, 8).map((r: any) => `• ${r.campaign_code}${r.recommendation === 'Mandatory' ? ' (obrigatória)' : ''} · ${r.client_name || `${r.model}-${r.serial_number}`} · prazo ${brDate(r.repair_deadline)}`).join('\n')}` : ''}`,
    actions: [
      ...insp.slice(0, 3).map((r: any) => ({ label: `Agendar 150h ${r.client_name || r.pin}`, choice: `__schedule|Visita 150h|${r.pin}|` })),
      ...camp.filter((r: any) => r.pin).slice(0, 2).map((r: any) => ({ label: `Agendar ${r.campaign_code} ${r.client_name || ''}`.trim(), choice: `__schedule|Campanha de campo|${r.pin}|` })),
    ],
    flow: null,
  };
}

async function resumoSemana(branches: string[], techs: Tech[], user: AppUser): Promise<FlowReply> {
  const [from, to] = weekRange();
  const rows = await apptsBetween(from, to, branches);
  const service = rows.filter((r) => !NON_SERVICE.includes(r.service_reason || ''));
  const byReason = new Map<string, number>();
  for (const r of service) byReason.set(r.service_reason || 'Sem motivo', (byReason.get(r.service_reason || 'Sem motivo') || 0) + 1);
  const total = rows.reduce((acc, r) => acc + Number(r.forecast_amount || 0), 0);
  const today = iso(new Date());
  const busyToday = new Set(rows.filter((r) => r.appointment_date === today).map((r) => r.technician_id));
  const pool = techs.filter((t) => !branches.length || branches.includes(t.branch));
  let qi = supabase.from('inspection_150h').select('pin', { count: 'exact', head: true }).is('executed_date', null);
  if (branches.length) qi = qi.in('branch', branches);
  const [{ count: pend150 }, { count: fup }] = await Promise.all([
    qi,
    supabase.from('followups').select('id', { count: 'exact', head: true }).neq('stage', 'encerrar').lte('next_followup_date', today).eq('created_by_matricula', user.matricula),
  ]);
  return {
    text: `Resumo da semana (${brDate(from)} a ${brDate(to)}):\n\n• ${service.length} atendimento(s) de serviço${rows.length - service.length ? ` + ${rows.length - service.length} folga/sem agenda/outros` : ''}\n• Faturamento previsto: ${money.format(total)}\n• Hoje: ${busyToday.size} de ${pool.length} técnicos com atendimento\n• Visita 150h em aberto: ${pend150 ?? 0}\n• Seus follow-ups vencidos ou para hoje: ${fup ?? 0}\n\nPor tipo:\n${Array.from(byReason.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `• ${k}: ${v}`).join('\n')}`,
    actions: [{ label: 'Carga por técnico', choice: '__say|carga da equipe na semana' }, { label: 'Faturamento', choice: '__say|quanto vamos faturar essa semana' }, { label: 'Pendências atrasadas', choice: '__say|150h e campanhas atrasadas' }],
    flow: null,
  };
}

function helpReply(): FlowReply {
  return {
    text: `Pode falar comigo do seu jeito. Alguns exemplos por assunto:

Agenda
• "agenda de amanhã em Marituba" · "onde está o Jonas hoje?"
• "quais técnicos estão livres sexta?" · "carga da equipe na semana"
• "agendar visita 150h" · "remarca a visita do Anderson pra segunda"
• "o Jonas faltou hoje, passa os atendimentos dele pro Frank"
• "dar folga pro Jonas sexta" · "férias do Frank de 20/10 a 30/10"
• "concluir/excluir o atendimento do Cezaro" · "anota no atendimento do Jonas: levar filtro"
• "atendimentos sem cidade"

Máquinas, 150h e campanhas
• "histórico da VCE0L60H..." · "a VCE0L60H... está com 1250 horas"
• "pendências de Marabá" · "150h e campanhas atrasadas"
• "o que o Anderson pode aproveitar na rota?" · "a máquina VCE... está em Itacoatiara"

Clientes e comercial
• "3 clientes de Barcarena há mais de 6 meses" · "quantos clientes temos em Barcarena?"
• "telefone da Ocidental" · "o telefone da Ocidental é 98 99999-0000"
• "abrir follow-up para a Britamazon" · "quem devo ligar hoje"

Faturamento e gestão
• "quanto vamos faturar essa semana?" · "o que falta faturar" · "marca como faturado o atendimento do Jonas"
• "resumo da semana"

Equipe
• "trocar a filial do Almivar" · "cadastrar técnico Pedro em Marabá" · "desativar técnico Jonas"

Toda ação pede confirmação antes de gravar, e "desfaz" volta a última.`,
    actions: [
      { label: 'Agenda de hoje', choice: '__say|agenda de hoje' },
      { label: 'Técnicos livres hoje', choice: '__say|quais técnicos estão ociosos hoje' },
      { label: 'Resumo da semana', choice: '__say|resumo da semana' },
      { label: 'Pendências atrasadas', choice: '__say|150h e campanhas atrasadas' },
    ],
    flow: null,
  };
}

// --- ações do pacote ---

async function askBill(flow: Extract<ArIAFlow, { kind: 'bill' }>): Promise<FlowReply> {
  if (!flow.appt) {
    const list = flow.candidates || [];
    if (!list.length) return { text: 'Não encontrei o atendimento para faturar. Diga o técnico, o cliente ou a data.', flow: null };
    if (list.length > 1) return { text: 'Qual atendimento foi faturado?', actions: list.map((a) => choice(apptLabel(a), a.id)), flow: { ...flow, step: 'pick' } };
    return askBill({ ...flow, appt: list[0] });
  }
  return { text: `Marcar como faturado: ${apptLabel(flow.appt)}?`, actions: CONFIRM, flow: { ...flow, step: 'confirm' } };
}

async function runBill(flow: Extract<ArIAFlow, { kind: 'bill' }>): Promise<FlowReply> {
  const a = flow.appt!;
  const { data: before } = await supabase.from('appointments').select('billing_status').eq('id', a.id).maybeSingle();
  const { error } = await supabase.from('appointments').update({ billing_status: 'faturado' }).eq('id', a.id);
  if (error) return { text: `Não consegui marcar: ${error.message}`, flow: null };
  const prev = before?.billing_status || 'nao_precificado';
  lastUndo = { label: `voltar o status de faturamento de ${apptLabel(a)}`, run: async () => (await supabase.from('appointments').update({ billing_status: prev }).eq('id', a.id)).error?.message || null };
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  return { text: `Pronto. ${apptLabel(a)} marcado como faturado.`, flow: null };
}

async function askHourmeter(flow: Extract<ArIAFlow, { kind: 'hourmeter' }>): Promise<FlowReply> {
  if (!flow.pin) return { text: 'Qual o PIN da máquina?', flow: null };
  if (!flow.appt) {
    const list = flow.candidates || [];
    if (!list.length) return { text: `O horímetro fica registrado num atendimento. Não encontrei atendimento recente da ${flow.pin} nos últimos 30 dias. Agende ou edite um atendimento dessa máquina e informe o horímetro nele.`, actions: [{ label: 'Agendar atendimento', choice: `__schedule|Revisão OS cliente|${flow.pin}|` }], flow: null };
    if (list.length > 1) return { text: 'Em qual atendimento registro o horímetro?', actions: list.map((a) => choice(apptLabel(a), a.id)), flow: { ...flow, step: 'pick' } };
    flow = { ...flow, appt: list[0] };
  }
  if (!flow.hours) return { text: `Qual o horímetro da ${flow.pin}?`, flow: { ...flow, step: 'hours' } };
  return { text: `Registrar ${flow.hours.toLocaleString('pt-BR')} h na ${flow.pin} (${apptLabel(flow.appt!)})?`, actions: CONFIRM, flow: { ...flow, step: 'confirm' } };
}

async function runHourmeter(flow: Extract<ArIAFlow, { kind: 'hourmeter' }>): Promise<FlowReply> {
  const a = flow.appt!;
  const { data: before } = await supabase.from('appointments').select('reported_hourmeter').eq('id', a.id).maybeSingle();
  const { error } = await supabase.from('appointments').update({ reported_hourmeter: flow.hours }).eq('id', a.id);
  if (error) return { text: `Não consegui registrar: ${error.message}`, flow: null };
  const prev = before?.reported_hourmeter ?? null;
  lastUndo = { label: `voltar o horímetro anterior da ${flow.pin}`, run: async () => (await supabase.from('appointments').update({ reported_hourmeter: prev }).eq('id', a.id)).error?.message || null };
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  return { text: `Pronto. Horímetro de ${flow.hours!.toLocaleString('pt-BR')} h registrado na ${flow.pin}.`, flow: null };
}

async function askContact(flow: Extract<ArIAFlow, { kind: 'contact' }>, userBranches: string[]): Promise<FlowReply> {
  if (!flow.branch) {
    if (!flow.client) return { text: 'De qual cliente é o telefone?', flow: { ...flow, step: 'client' } };
    const found = await findClients(flow.client, userBranches);
    if (!found.length) return { text: `Não encontrei "${flow.client}" no G4. Digite o nome como aparece no G4.`, flow: { ...flow, step: 'client', client: '' } };
    if (found.length > 1) return { text: 'Qual destes clientes?', actions: found.map((c, i) => choice(`${c.client} · ${c.branch}`, `__client|${i}`)), flow: { ...flow, step: 'client', candidates: found } };
    flow = { ...flow, client: found[0].client, branch: found[0].branch };
  }
  if (!flow.phone) return { text: `Qual o telefone de ${flow.client}?`, flow: { ...flow, step: 'phone' } };
  return { text: `Salvar o telefone ${flow.phone} para ${flow.client} (${flow.branch})? Ele passa a aparecer nos atendimentos desse cliente.`, actions: CONFIRM, flow: { ...flow, step: 'confirm' } };
}

async function runContact(flow: Extract<ArIAFlow, { kind: 'contact' }>): Promise<FlowReply> {
  const key = `${flow.client!.trim().toUpperCase()}|${flow.branch!.trim().toUpperCase()}`;
  const { data: before } = await supabase.from('client_contacts').select('phone').eq('client_key', key).limit(1);
  const { error } = await supabase.from('client_contacts').upsert({ client_key: key, branch: flow.branch!.trim().toUpperCase(), client_name: flow.client!.trim(), phone: flow.phone, updated_at: new Date().toISOString() }, { onConflict: 'client_key' });
  if (error) return { text: `Não consegui salvar: ${error.message}`, flow: null };
  const prev = (before || [])[0]?.phone;
  lastUndo = { label: `voltar o telefone anterior de ${flow.client}`, run: async () => (prev
    ? (await supabase.from('client_contacts').update({ phone: prev }).eq('client_key', key)).error?.message
    : (await supabase.from('client_contacts').delete().eq('client_key', key)).error?.message) || null };
  return { text: `Pronto. Telefone de ${flow.client} salvo.`, flow: null };
}

function daysBetween(start: string, end: string) {
  const out: string[] = [];
  const d = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  while (d <= last && out.length < 40) { if (d.getDay() !== 0) out.push(iso(d)); d.setDate(d.getDate() + 1); }
  return out;
}

async function askLeave(flow: Extract<ArIAFlow, { kind: 'leave' }>): Promise<FlowReply> {
  if (!flow.tech) return { text: `${flow.reason} para qual técnico?`, actions: (await loadTechnicians()).slice(0, 20).map((t) => choice(`${t.name} · ${t.branch}`, t.id)), flow: { ...flow, step: 'tech' } };
  if (!flow.start) return { text: `Para qual dia? Se for um período, digite "de 20/10 a 30/10".`, actions: nextWorkdays(6).map((d) => choice(brDate(d), d)), flow: { ...flow, step: 'start' } };
  const days = daysBetween(flow.start, flow.end || flow.start);
  const { data } = await supabase.from('appointments').select('appointment_date,client_name,service_reason').eq('technician_id', flow.tech.id).in('appointment_date', days);
  const conflicts = (data || []).filter((r: any) => !['Folga', 'Férias', 'Sem agenda'].includes(r.service_reason || ''));
  return {
    text: `Lançar ${flow.reason} para ${flow.tech.name} em ${days.length === 1 ? brDate(days[0]) : `${days.length} dias (${brDate(days[0])} a ${brDate(days[days.length - 1])}, sem domingos)`}?${conflicts.length ? `\n\nAtenção: ele já tem ${conflicts.length} atendimento(s) nesse período (${conflicts.slice(0, 3).map((c: any) => `${brDate(c.appointment_date)} ${c.client_name || c.service_reason}`).join('; ')}). Depois remarque ou passe para outro técnico.` : ''}`,
    actions: CONFIRM,
    flow: { ...flow, step: 'confirm' },
  };
}

async function runLeave(flow: Extract<ArIAFlow, { kind: 'leave' }>): Promise<FlowReply> {
  const days = daysBetween(flow.start!, flow.end || flow.start!);
  const { data, error } = await supabase.from('appointments').insert(days.map((d) => ({ branch: flow.tech!.branch, appointment_date: d, technician_id: flow.tech!.id, service_reason: flow.reason, description: 'Lançado pela ArIA' }))).select('id');
  if (error) return { text: `Não consegui lançar: ${error.message}`, flow: null };
  const ids = (data || []).map((r: any) => r.id);
  remember(flow.tech!.name);
  lastUndo = { label: `apagar ${flow.reason.toLowerCase()} de ${flow.tech!.name} (${ids.length} dia(s))`, run: async () => (await supabase.from('appointments').delete().in('id', ids)).error?.message || null };
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  return { text: `Pronto. ${flow.reason} lançada para ${flow.tech!.name} em ${ids.length} dia(s).`, actions: [{ label: 'Abrir Agenda', view: 'agenda' }], flow: null };
}

async function askMoveDay(flow: Extract<ArIAFlow, { kind: 'move_day' }>): Promise<FlowReply> {
  const techs = await loadTechnicians();
  if (!flow.from) return { text: 'Qual técnico não vai poder atender?', actions: techs.slice(0, 20).map((t) => choice(`${t.name} · ${t.branch}`, t.id)), flow: { ...flow, step: 'from' } };
  const { data } = await supabase.from('appointments').select('id,client_name,service_reason,service_city').eq('technician_id', flow.from.id).eq('appointment_date', flow.date);
  const rows = (data || []).filter((r: any) => !['Folga', 'Férias', 'Sem agenda'].includes(r.service_reason || ''));
  if (!rows.length) return { text: `${flow.from.name} não tem atendimentos em ${brDate(flow.date)} para passar.`, flow: null };
  if (!flow.to) {
    const { data: busy } = await supabase.from('appointments').select('technician_id').eq('appointment_date', flow.date);
    const busySet = new Set((busy || []).map((r: any) => r.technician_id));
    const options = techs.filter((t) => t.id !== flow.from!.id).sort((a, b) => Number(a.branch !== flow.from!.branch) - Number(b.branch !== flow.from!.branch) || Number(busySet.has(a.id)) - Number(busySet.has(b.id)));
    return { text: `${flow.from.name} tem ${rows.length} atendimento(s) em ${brDate(flow.date)}: ${rows.map((r: any) => r.client_name || r.service_reason).join('; ')}.\nPara quem passo? (✓ = livre nesse dia)`, actions: options.slice(0, 10).map((t) => choice(`${busySet.has(t.id) ? '' : '✓ '}${t.name} · ${t.branch}`, t.id)), flow: { ...flow, step: 'to', ids: rows.map((r: any) => r.id) } };
  }
  return { text: `Passar ${rows.length} atendimento(s) de ${flow.from.name} em ${brDate(flow.date)} para ${flow.to.name} (${flow.to.branch})?`, actions: CONFIRM, flow: { ...flow, step: 'confirm', ids: rows.map((r: any) => r.id) } };
}

async function runMoveDay(flow: Extract<ArIAFlow, { kind: 'move_day' }>): Promise<FlowReply> {
  const ids = flow.ids || [];
  const from = flow.from!;
  const { error } = await supabase.from('appointments').update({ technician_id: flow.to!.id, branch: flow.to!.branch }).in('id', ids);
  if (error) return { text: `Não consegui passar: ${error.message}`, flow: null };
  remember(flow.to!.name);
  lastUndo = { label: `devolver os ${ids.length} atendimento(s) para ${from.name}`, run: async () => (await supabase.from('appointments').update({ technician_id: from.id, branch: from.branch }).in('id', ids)).error?.message || null };
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  return { text: `Pronto. ${ids.length} atendimento(s) passados de ${from.name} para ${flow.to!.name}. Quer lançar folga ou atestado para ${from.name} nesse dia?`, actions: [{ label: `Lançar folga para ${from.name}`, choice: `__say|dar folga pro ${from.name} ${brDate(flow.date).split(', ')[1] || ''}` }, { label: 'Abrir Agenda', view: 'agenda' }], flow: null };
}

async function askNote(flow: Extract<ArIAFlow, { kind: 'note' }>): Promise<FlowReply> {
  if (!flow.appt) {
    const list = flow.candidates || [];
    if (!list.length) return { text: 'Não encontrei o atendimento. Diga o técnico, o cliente ou a data.', flow: null };
    if (list.length > 1) return { text: 'Em qual atendimento anoto?', actions: list.map((a) => choice(apptLabel(a), a.id)), flow: { ...flow, step: 'pick' } };
    flow = { ...flow, appt: list[0] };
  }
  if (!flow.text) return { text: 'O que devo anotar?', flow: { ...flow, step: 'text' } };
  return { text: `Anotar em ${apptLabel(flow.appt!)}:\n"${flow.text}"?`, actions: CONFIRM, flow: { ...flow, step: 'confirm' } };
}

async function runNote(flow: Extract<ArIAFlow, { kind: 'note' }>): Promise<FlowReply> {
  const a = flow.appt!;
  const { data: before } = await supabase.from('appointments').select('description').eq('id', a.id).maybeSingle();
  const prev = before?.description || '';
  const next = prev ? `${prev}\n${flow.text}` : flow.text;
  const { error } = await supabase.from('appointments').update({ description: next }).eq('id', a.id);
  if (error) return { text: `Não consegui anotar: ${error.message}`, flow: null };
  lastUndo = { label: 'remover a anotação', run: async () => (await supabase.from('appointments').update({ description: prev || null }).eq('id', a.id)).error?.message || null };
  window.dispatchEvent(new CustomEvent('aria:data-changed'));
  return { text: 'Pronto. Anotado no atendimento.', flow: null };
}

// ---------- Intenção interpretada pela IA ----------

export async function runArIAIntent(intent: string, args: Record<string, string>, user: AppUser, userBranches: string[]): Promise<FlowReply | null> {
  const a = (k: string) => String(args?.[k] || '').trim();
  const techs = await loadTechnicians();
  const findTech = (name: string) => (name ? techInText(name, techs) || techs.find((t) => fold(t.name) === fold(name)) : undefined);
  const branches = await loadActiveBranches();
  const findBranch = (name: string) => (name ? branches.find((b) => fold(b) === fold(name)) || branches.find((b) => fold(name).includes(fold(b))) : undefined);
  const date = (value: string) => (value ? parseDate(value) || undefined : undefined);

  switch (intent) {
    case 'trocar_filial_tecnico': {
      const tech = findTech(a('tecnico'));
      const toBranch = findBranch(a('filial'));
      return askTechBranch({ kind: 'tech_branch', step: 'tech', tech, toBranch: toBranch && toBranch !== tech?.branch ? toBranch : undefined });
    }
    case 'agendar_atendimento': {
      const tipo = a('tipo');
      const reason = /150/.test(tipo) ? 'Visita 150h' : /campanha/i.test(tipo) ? 'Campanha de campo' : tipo || 'Revisão OS cliente';
      const pin = serialInText(a('pin')) || a('pin').toUpperCase();
      let machine: Machine | undefined = pin ? (await machineBySerial(pin)) || { serial: pin, client: a('cliente'), city: '', branch: '', label: pin } : undefined;
      if (!machine && a('cliente')) machine = { serial: '', client: a('cliente'), city: '', branch: '', label: a('cliente') };
      return askSchedule({ kind: 'schedule', step: 'machine', reason, machine, tech: findTech(a('tecnico')), date: date(a('data')) }, user, userBranches);
    }
    case 'remarcar_atendimento':
    case 'concluir_atendimento':
    case 'excluir_atendimento': {
      const op = intent === 'remarcar_atendimento' ? 'reschedule' : intent === 'concluir_atendimento' ? 'complete' : 'delete';
      const tech = findTech(a('tecnico'));
      const when = date(a('data_atual') || a('data'));
      let candidates = await findAppointments(techs, tech, a('cliente_ou_pin'), when, op === 'complete');
      if (!candidates.length && when) candidates = await findAppointments(techs, tech, a('cliente_ou_pin'), undefined, op === 'complete');
      return askAppt({ kind: 'appt', op, step: 'pick', candidates, newDate: date(a('nova_data')), newTech: findTech(a('novo_tecnico')) });
    }
    case 'adicionar_tecnico':
      return askTechAdd({ kind: 'tech_add', step: 'name', name: a('nome') || undefined, branch: findBranch(a('filial')) });
    case 'desativar_tecnico':
      return askTechOff({ kind: 'tech_off', step: 'tech', tech: findTech(a('tecnico')) });
    case 'criar_followup':
      return askFollowup({ kind: 'followup', step: 'client', client: a('cliente'), notes: a('observacao') || undefined, date: date(a('data_retorno')) }, userBranches);
    case 'informar_cidade_maquina':
      return askMachineCity({ kind: 'machine_city', step: 'pin', pin: (serialInText(a('pin')) || a('pin').toUpperCase()) || undefined, city: a('cidade') || undefined });
    case 'oportunidades_rota': {
      const tech = findTech(a('tecnico'));
      if (!tech) return { text: 'De qual técnico você quer ver a rota?', actions: techs.slice(0, 12).map((t) => choice(`${t.name} · ${t.branch}`, `__route|${t.id}`)), flow: null };
      return routeOpportunities(tech);
    }
    case 'pendencias_filial': {
      const named = findBranch(a('filial'));
      const scope = named ? [named] : userBranches.length ? userBranches : branches;
      return branchPendencies(scope, named ? `de ${named}` : 'das suas filiais');
    }
    case 'tecnicos_ociosos': {
      const day = date(a('data')) || iso(new Date());
      const branch = findBranch(a('filial'));
      const scope = branch ? [branch] : userBranches;
      const pool = techs.filter((t) => !scope.length || scope.includes(t.branch));
      const { data } = await supabase.from('appointments').select('technician_id,service_reason').eq('appointment_date', day).in('technician_id', pool.map((t) => t.id));
      const busy = new Set((data || []).filter((r: any) => !['Sem agenda'].includes(r.service_reason || '')).map((r: any) => r.technician_id));
      const off = new Set((data || []).filter((r: any) => ['Folga', 'Férias'].includes(r.service_reason || '')).map((r: any) => r.technician_id));
      const idle = pool.filter((t) => !busy.has(t.id));
      const label = `${brDate(day)}${branch ? ` em ${branch}` : ''}`;
      if (!idle.length) return { text: `Todos os técnicos${branch ? ` de ${branch}` : ' das suas filiais'} têm atendimento em ${brDate(day)}.`, flow: null };
      return {
        text: `Técnicos sem atendimento agendado ${label} (${idle.length} de ${pool.length}):\n\n${idle.map((t, i) => `${i + 1}. ${t.name} · ${t.branch}`).join('\n')}${off.size ? `\n\n(${off.size} técnico(s) estão de folga ou férias e não entram na lista.)` : ''}\n\nQuer agendar algum deles?`,
        actions: idle.slice(0, 6).map((t) => ({ label: `Agendar ${t.name}`, choice: `__schedule|Revisão OS cliente||${t.id}` })),
        flow: null,
      };
    }
    case 'ajuda': return helpReply();
    case 'agenda_dia': {
      const named = findBranch(a('filial'));
      const scope = scopeBranches(named, userBranches);
      if (a('semana')) return resumoSemana(scope, techs, user);
      return agendaDia(date(a('data')) || iso(new Date()), scope, techs, named ? ` em ${named}` : '');
    }
    case 'onde_tecnico': {
      const tech = findTech(a('tecnico'));
      if (!tech) return { text: 'De qual técnico?', actions: techs.slice(0, 12).map((t) => choice(`${t.name} · ${t.branch}`, `__say|onde está o ${t.name} ${a('data') ? brDate(date(a('data'))!) : 'hoje'}`)), flow: null };
      remember(tech.name);
      return ondeTecnico(tech, date(a('data')) || iso(new Date()));
    }
    case 'carga_semana': return cargaSemana(scopeBranches(findBranch(a('filial')), userBranches), techs);
    case 'faturamento': return faturamento(scopeBranches(findBranch(a('filial')), userBranches), a('periodo') || 'semana');
    case 'pendentes_faturamento': return pendentesFaturamento(scopeBranches(findBranch(a('filial')), userBranches), techs);
    case 'faturar_atendimento': {
      const tech = findTech(a('tecnico'));
      const when = date(a('data'));
      let candidates = await findAppointments(techs, tech, a('cliente_ou_pin'), when, true);
      if (!candidates.length && when) candidates = await findAppointments(techs, tech, a('cliente_ou_pin'), undefined, true);
      return askBill({ kind: 'bill', step: 'pick', candidates });
    }
    case 'historico_maquina': {
      const pin = serialInText(a('pin')) || a('pin').toUpperCase();
      if (!pin) return { text: 'Qual o PIN da máquina?', flow: null };
      return historicoMaquina(pin);
    }
    case 'registrar_horimetro': {
      const pin = serialInText(a('pin')) || a('pin').toUpperCase();
      const hours = Number(a('horas')) || undefined;
      let candidates: Appt[] = [];
      if (pin) {
        const from = new Date(); from.setDate(from.getDate() - 30);
        const { data } = await supabase.from('appointments').select('id,appointment_date,client_name,equipment_serial,service_city,service_reason,technician_id,branch').eq('equipment_serial', pin).gte('appointment_date', iso(from)).lte('appointment_date', iso(new Date())).order('appointment_date', { ascending: false }).limit(5);
        const names = new Map(techs.map((t) => [t.id, t.name]));
        candidates = (data || []).map((row: any) => ({ ...row, techName: names.get(row.technician_id) || 'Técnico' }));
      }
      return askHourmeter({ kind: 'hourmeter', step: 'pick', pin: pin || undefined, hours, candidates });
    }
    case 'contato_cliente': return contatoCliente(a('cliente'), userBranches);
    case 'salvar_contato': return askContact({ kind: 'contact', step: 'client', client: a('cliente') || undefined, phone: a('telefone') || undefined }, userBranches);
    case 'atendimentos_incompletos': return incompletos(scopeBranches(findBranch(a('filial')), userBranches), techs);
    case 'pendencias_atrasadas': return atrasadas(scopeBranches(findBranch(a('filial')), userBranches));
    case 'resumo_semana': return resumoSemana(scopeBranches(findBranch(a('filial')), userBranches), techs, user);
    case 'folga_ferias': {
      const tech = findTech(a('tecnico'));
      if (tech) remember(tech.name);
      return askLeave({ kind: 'leave', step: 'tech', tech, reason: a('tipo') || 'Folga', start: date(a('inicio')), end: date(a('fim')) });
    }
    case 'realocar_dia': {
      const from = findTech(a('tecnico'));
      const to = findTech(a('novo_tecnico'));
      return askMoveDay({ kind: 'move_day', step: 'from', from, to: to && to.id !== from?.id ? to : undefined, date: date(a('data')) || iso(new Date()) });
    }
    case 'adicionar_observacao': {
      const tech = findTech(a('tecnico'));
      const candidates = await findAppointments(techs, tech, a('cliente_ou_pin'), date(a('data')));
      return askNote({ kind: 'note', step: 'pick', candidates, text: a('texto') || undefined });
    }
    case 'navegar': {
      const tela = fold(a('tela'));
      const map: [RegExp, ArIAAction][] = [
        [/150/, { label: 'Abrir Visita 150h', view: 'inspecao150' }],
        [/campanha/, { label: 'Abrir Campanhas', view: 'campanhas' }],
        [/mapa/, { label: 'Abrir mapa', view: 'retencao', mode: 'map' }],
        [/retenc/, { label: 'Abrir Retenção', view: 'retencao' }],
        [/follow/, { label: 'Abrir Follow-up', view: 'followup' }],
        [/dashboard|painel/, { label: 'Abrir Dashboard', view: 'dashboard' }],
        [/usuario|acesso/, { label: 'Abrir Usuários', view: 'usuarios' }],
        [/agenda/, { label: 'Abrir Agenda', view: 'agenda' }],
      ];
      const hit = map.find(([re]) => re.test(tela));
      return hit ? { text: `Claro. ${hit[1].label}.`, actions: [hit[1]], flow: null } : null;
    }
    default:
      return null;
  }
}

// ---------- Entrada ----------

async function nluContext() {
  const [techs, branches] = await Promise.all([loadTechnicians(), loadActiveBranches()]);
  return { technicians: techs.map((t) => ({ name: t.name, branch: t.branch })), branches };
}

const ACTION_HINT = /\b(agend|marc|remarc|reagend|troc|mud|pass|transfer|desativ|adicion|cadastr|abr|cri|conclu|finaliz|exclu|apag|cancel|desmarc|registr|coloc|jog|tir)/;

export async function startArIAFlow(message: string, user: AppUser, userBranches: string[]): Promise<FlowReply | null> {
  if (/^(cancela|cancelar|cancele|desisto|esquece|deixa)\b/.test(fold(message)) && fold(message).split(' ').length <= 2) return { text: 'Não há nenhuma ação em andamento para cancelar.', flow: null };
  const t = fold(message);
  if (/^(oi|ola|ole|bom dia|boa tarde|boa noite|e ai|eai|hey|opa|salve|tudo bem|tudo bom)\b/.test(t) && t.split(' ').length <= 5) {
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
    return {
      text: `${hello}, ${user.name.split(' ')[0]}! Em que posso ajudar? Você pode pedir do seu jeito, por exemplo:`,
      actions: [
        { label: 'Pendências da minha filial', choice: '__say|quais as pendências da minha filial' },
        { label: 'Agendar Visita 150h', choice: '__say|agendar visita 150h' },
        { label: 'Quem ligar hoje', choice: '__say|quem devo ligar hoje' },
        { label: 'O que você faz?', choice: '__say|o que você consegue fazer?' },
      ],
      flow: null,
    };
  }
  if (/^(obrigad|valeu|vlw|brigad|show|top|perfeito|otimo|beleza|blz|massa)\b/.test(t) && t.split(' ').length <= 5) {
    return { text: 'Por nada! Se precisar de mais alguma coisa, é só pedir.', flow: null };
  }
  if (/^(desfaz|desfazer|volta atras|voltar atras|reverte|reverter|desfaca|anula)/.test(t)) {
    if (!lastUndo) return { text: 'Não tenho nenhuma ação recente para desfazer nesta conversa.', flow: null };
    return { text: `Quer desfazer a última ação: ${lastUndo.label}?`, actions: CONFIRM, flow: { kind: 'undo', step: 'confirm' } };
  }
  if (isCityProspectIntent(message)) return null;
  const ctx = await nluContext();
  const result = interpret(message, ctx, undefined, memory);
  if (result?.args?.tecnico) remember(result.args.tecnico);
  if (result) {
    const reply = await runArIAIntent(result.intent, result.args, user, userBranches);
    if (reply) return reply;
  }
  return null;
}

export function intentMenu(message: string): FlowReply | null {
  if (ACTION_HINT.test(fold(message))) {
    return {
      text: 'Não tenho certeza do que você quer fazer. Escolha a ação e eu sigo daqui (vou lembrar dessa forma de pedir):',
      actions: (Object.keys(INTENT_LABELS) as NluIntent[]).map((intent) => ({ label: INTENT_LABELS[intent], choice: `__intent|${intent}|${encodeURIComponent(message)}` })),
      flow: null,
    };
  }
  return null;
}

// Resposta que não é uma opção válida: se parecer um pedido novo (3+ palavras), abandona o fluxo.
function retry(text: string, flow: ArIAFlow, input: string): FlowReply | null {
  if (input.trim().split(/\s+/).length >= 3) return null;
  return { text, flow };
}

export async function continueArIAFlow(flow: ArIAFlow | null, input: string, user: AppUser, userBranches: string[]): Promise<FlowReply | null> {
  if (input.startsWith('__schedule|')) {
    const [, reason, serial, techId] = input.split('|');
    const techs = await loadTechnicians();
    const machine = serial ? await machineBySerial(serial) : null;
    return askSchedule({ kind: 'schedule', step: 'machine', reason, machine: machine || undefined, tech: techs.find((t) => t.id === techId) }, user, userBranches);
  }
  if (input.startsWith('__intent|')) {
    const [, intent, encoded] = input.split('|');
    const original = decodeURIComponent(encoded || '');
    const ctx = await nluContext();
    learnIntent(original, intent as NluIntent, ctx);
    const forced = interpret(original, ctx, intent as NluIntent);
    return runArIAIntent(intent, forced?.args || {}, user, userBranches);
  }
  if (input.startsWith('__say|')) return startArIAFlow(input.slice(6), user, userBranches);
  if (input.startsWith('__bill|')) {
    const techs = await loadTechnicians();
    const { data } = await supabase.from('appointments').select('id,appointment_date,client_name,equipment_serial,service_city,service_reason,technician_id,branch').eq('id', input.split('|')[1]).maybeSingle();
    if (!data) return { text: 'Não encontrei esse atendimento.', flow: null };
    return askBill({ kind: 'bill', step: 'pick', candidates: [{ ...(data as any), techName: techs.find((t) => t.id === (data as any).technician_id)?.name || 'Técnico' }] });
  }
  if (input.startsWith('__wa|')) {
    let digits = input.slice(5).replace(/\D/g, '');
    if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
    window.open(`https://wa.me/${digits}`, '_blank', 'noopener');
    return { text: 'Abri o WhatsApp em outra aba.', flow: null };
  }
  if (input.startsWith('__route|')) {
    const tech = (await loadTechnicians()).find((t) => t.id === input.split('|')[1]);
    return tech ? routeOpportunities(tech) : null;
  }
  if (!flow) return null;
  const text = fold(input);
  if (input === '__cancel' || /^(cancela|cancelar|nao|desisto|esquece)\b/.test(text)) return { text: 'Tudo bem, cancelei. Nada foi alterado.', flow: null };
  if (!input.startsWith('__') && input.length > 3 && flow.step !== 'confirm') {
    const fresh = interpret(input, await nluContext());
    if ((fresh && fresh.score >= 6) || /^(quais|qual|quem|mostr|ver )/.test(text)) return null;
  }
  const yes = input === '__confirm' || /^(sim|confirm|pode|ok|isso)/.test(text);

  if (flow.kind === 'bill') {
    if (flow.step === 'pick') {
      const appt = flow.candidates?.find((c) => c.id === input);
      return appt ? askBill({ ...flow, appt }) : retry('Escolha um dos atendimentos acima.', flow, input);
    }
    return yes ? runBill(flow) : null;
  }
  if (flow.kind === 'hourmeter') {
    if (flow.step === 'pick') {
      const appt = flow.candidates?.find((c) => c.id === input);
      return appt ? askHourmeter({ ...flow, appt }) : retry('Escolha um dos atendimentos acima.', flow, input);
    }
    if (flow.step === 'hours') {
      const hours = Number(input.replace(/[^\d]/g, ''));
      return hours ? askHourmeter({ ...flow, hours }) : retry('Digite só o número de horas.', flow, input);
    }
    return yes ? runHourmeter(flow) : null;
  }
  if (flow.kind === 'contact') {
    if (flow.step === 'client') {
      if (input.startsWith('__client|')) {
        const picked = flow.candidates?.[Number(input.split('|')[1])];
        if (picked) return askContact({ ...flow, client: picked.client, branch: picked.branch }, userBranches);
      }
      return askContact({ ...flow, client: input.trim(), branch: undefined }, userBranches);
    }
    if (flow.step === 'phone') {
      const phone = input.replace(/[^\d()\s-]/g, '').trim();
      return phone.replace(/\D/g, '').length >= 8 ? askContact({ ...flow, phone }, userBranches) : retry('Esse número parece incompleto. Digite com DDD.', flow, input);
    }
    return yes ? runContact(flow) : null;
  }
  if (flow.kind === 'leave') {
    if (flow.step === 'tech') {
      const techs = await loadTechnicians();
      const tech = techs.find((t) => t.id === input) || techInText(input, techs);
      return tech ? askLeave({ ...flow, tech }) : retry('Não encontrei esse técnico.', flow, input);
    }
    if (flow.step === 'start') {
      const found = extractDatesAll(input);
      if (!found.length) return retry('Não entendi a data. Escolha uma opção ou digite como 20/10 ou "de 20/10 a 30/10".', flow, input);
      return askLeave({ ...flow, start: found[0], end: found[1] });
    }
    return yes ? runLeave(flow) : null;
  }
  if (flow.kind === 'move_day') {
    const techs = await loadTechnicians();
    if (flow.step === 'from') {
      const from = techs.find((t) => t.id === input) || techInText(input, techs);
      return from ? askMoveDay({ ...flow, from }) : retry('Não encontrei esse técnico.', flow, input);
    }
    if (flow.step === 'to') {
      const to = techs.find((t) => t.id === input) || techInText(input, techs);
      return to ? askMoveDay({ ...flow, to }) : retry('Não encontrei esse técnico.', flow, input);
    }
    return yes ? runMoveDay(flow) : null;
  }
  if (flow.kind === 'note') {
    if (flow.step === 'pick') {
      const appt = flow.candidates?.find((c) => c.id === input);
      return appt ? askNote({ ...flow, appt }) : retry('Escolha um dos atendimentos acima.', flow, input);
    }
    if (flow.step === 'text') return askNote({ ...flow, text: input.trim() });
    return yes ? runNote(flow) : null;
  }
  if (flow.kind === 'undo') {
    if (!yes || !lastUndo) return null;
    const undo = lastUndo;
    lastUndo = null;
    const failure = await undo.run();
    if (failure) return { text: `Não consegui desfazer: ${failure}`, flow: null };
    window.dispatchEvent(new CustomEvent('aria:data-changed'));
    return { text: `Pronto, desfeito: ${undo.label}.`, flow: null };
  }
  if (flow.kind === 'appt') {
    if (flow.step === 'pick') {
      const appt = flow.candidates?.find((c) => c.id === input);
      if (!appt) return retry('Escolha um dos atendimentos acima.', flow, input);
      return askAppt({ ...flow, appt });
    }
    if (flow.step === 'date') {
      const newDate = parseDate(input);
      if (!newDate) return retry('Não entendi a data. Escolha uma opção ou digite como 15/10 ou "sexta".', flow, input);
      return askAppt({ ...flow, newDate });
    }
    return yes ? runAppt(flow) : null;
  }
  if (flow.kind === 'tech_add') {
    if (flow.step === 'name') return askTechAdd({ ...flow, name: input.trim() });
    if (flow.step === 'branch') {
      const branch = (await loadActiveBranches()).find((b) => fold(b) === text || text.includes(fold(b)));
      if (!branch) return retry('Não reconheci essa filial. Escolha uma das opções.', flow, input);
      return askTechAdd({ ...flow, branch });
    }
    return yes ? runTechAdd(flow) : null;
  }
  if (flow.kind === 'tech_off') {
    if (flow.step === 'tech') {
      const techs = await loadTechnicians();
      const tech = techs.find((t) => t.id === input) || techInText(input, techs);
      if (!tech) return retry('Não encontrei esse técnico.', flow, input);
      return askTechOff({ ...flow, tech });
    }
    return yes ? runTechOff(flow) : null;
  }
  if (flow.kind === 'followup') {
    if (flow.step === 'client') {
      if (input.startsWith('__client|')) {
        const picked = flow.candidates?.[Number(input.split('|')[1])];
        if (picked) return askFollowup({ ...flow, client: picked.client, branch: picked.branch }, userBranches);
      }
      return askFollowup({ ...flow, client: input.trim(), branch: undefined }, userBranches);
    }
    return yes ? runFollowup(flow, user) : null;
  }
  if (flow.kind === 'machine_city') {
    if (flow.step === 'pin') return askMachineCity({ ...flow, pin: serialInText(input) || input.toUpperCase().trim() });
    if (flow.step === 'city') return askMachineCity({ ...flow, city: input.trim() });
    return yes ? runMachineCity(flow, user) : null;
  }
  if (input === '__cancel' || /^(cancela|cancelar|nao|desisto|esquece)\b/.test(text)) return { text: 'Tudo bem, cancelei. Nada foi alterado.', flow: null };

  if (flow.kind === 'tech_branch') {
    if (flow.step === 'tech') {
      const techs = await loadTechnicians();
      const tech = techs.find((t) => t.id === input) || techInText(input, techs);
      if (!tech) return retry('Não encontrei esse técnico. Escolha uma das opções acima ou digite o nome.', flow, input);
      return askTechBranch({ ...flow, tech });
    }
    if (flow.step === 'branch') {
      const branches = await loadActiveBranches();
      const toBranch = branches.find((b) => fold(b) === text) || branches.find((b) => text.includes(fold(b)));
      if (!toBranch) return retry('Não reconheci essa filial. Escolha uma das opções acima.', flow, input);
      return askTechBranch({ ...flow, toBranch });
    }
    if (input === '__confirm' || /^(sim|confirm|pode|ok)/.test(text)) return runTechBranch(flow);
    return null;
  }

  if (flow.step === 'machine') {
    const serial = serialInText(input) || input.toUpperCase().trim();
    const machine = await machineBySerial(serial);
    if (!machine) return retry(`Não encontrei a máquina ${serial} no G4. Confira o PIN ou escolha uma das opções.`, flow, input);
    return askSchedule({ ...flow, machine }, user, userBranches);
  }
  if (flow.step === 'tech') {
    const techs = await loadTechnicians();
    const tech = techs.find((t) => t.id === input) || techInText(input, techs);
    if (!tech) return retry('Não encontrei esse técnico. Escolha uma das opções ou digite o nome.', flow, input);
    return askSchedule({ ...flow, tech }, user, userBranches);
  }
  if (flow.step === 'date') {
    const date = parseDate(input);
    if (!date) return retry('Não entendi a data. Escolha uma opção ou digite como 15/10 ou "sexta".', flow, input);
    return askSchedule({ ...flow, date }, user, userBranches);
  }
  if (input === '__confirm' || /^(sim|confirm|pode|ok)/.test(text)) return runSchedule(flow);
  return null;
}
