import { supabase } from './supabase';
import type { AppUser } from '../session';
import type { ArIAAction, ArIAReply } from './ariaBrain';
import { effectiveCity } from '../features/ServiceProgramsView';
import { INTENT_LABELS, interpret, learnIntent, type NluIntent } from './ariaNlu';

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
  | { kind: 'undo'; step: 'confirm' };

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
      if (!appt) return { text: 'Escolha um dos atendimentos acima.', flow };
      return askAppt({ ...flow, appt });
    }
    if (flow.step === 'date') {
      const newDate = parseDate(input);
      if (!newDate) return { text: 'Não entendi a data. Escolha uma opção ou digite como 15/10 ou "sexta".', flow };
      return askAppt({ ...flow, newDate });
    }
    return yes ? runAppt(flow) : null;
  }
  if (flow.kind === 'tech_add') {
    if (flow.step === 'name') return askTechAdd({ ...flow, name: input.trim() });
    if (flow.step === 'branch') {
      const branch = (await loadActiveBranches()).find((b) => fold(b) === text || text.includes(fold(b)));
      if (!branch) return { text: 'Não reconheci essa filial. Escolha uma das opções.', flow };
      return askTechAdd({ ...flow, branch });
    }
    return yes ? runTechAdd(flow) : null;
  }
  if (flow.kind === 'tech_off') {
    if (flow.step === 'tech') {
      const techs = await loadTechnicians();
      const tech = techs.find((t) => t.id === input) || techInText(input, techs);
      if (!tech) return { text: 'Não encontrei esse técnico.', flow };
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
