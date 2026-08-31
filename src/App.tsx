import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { AppointmentDrawer } from './components/AppointmentDrawer';
import { TechnicianDrawer } from './components/TechnicianDrawer';
import { FollowupDrawer } from './components/FollowupDrawer';
import { InsightsDrawer } from './components/InsightsDrawer';
import { ClientDetailDrawer } from './components/ClientDetailDrawer';
import { HomeView } from './features/HomeView';
import { AgendaView } from './features/AgendaView';
import { RetentionView } from './features/RetentionView';
import { FollowupView } from './features/FollowupView';
import { supabase } from './lib/supabase';
import { addDays, isoDate, startOfWeek } from './lib/date';
import { emptyAppointment, emptyFollowup } from './drafts';
import type { AppointmentDraft, FollowupDraft } from './drafts';
import type { Appointment, Branch, ClientSummary, Followup, HistoryRow, Insight, MachineSummary, Technician, ViewName } from './types';
import { useSession } from './session';
import './styles.css';

const ALL = '__all__';
const MULTI_SEPARATOR = '||';
const RETENTION_PAGE_SIZE = 1000;
const retentionKey = (clientName: string, branchName: string) => `${clientName.trim().toUpperCase()}|${branchName.trim().toUpperCase()}`;
const selectedBranchValues = (filter: string) => filter === ALL ? [] : filter.split(MULTI_SEPARATOR).map((item) => item.trim()).filter(Boolean);
const effectiveBranchValues = (filter: string, available: Branch[]) => {
  const selected = selectedBranchValues(filter);
  return selected.length ? selected : available.map((item) => item.name);
};

function parseMoney(value: string) {
  if (!value.trim()) return null;
  const normalized = value.replace(/\./g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function followupToDraft(item: Followup): FollowupDraft {
  return {
    id: item.id,
    branch: item.branch,
    client_name: item.client_name,
    equipment_serial: item.equipment_serial || '',
    stage: item.stage || 'prospectar',
    next_followup_date: item.next_followup_date || '',
    notes: item.notes || '',
    result: item.result || '',
    sale_kind: item.sale_kind || '',
    parts_value: item.parts_value == null ? '' : String(item.parts_value),
    services_value: item.services_value == null ? '' : String(item.services_value),
  };
}

export default function App() {
  const { user, branches: allowedBranches } = useSession();
  const [view, setView] = useState<ViewName>('agenda');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branch, setBranch] = useState(ALL);
  const [weekStart, setWeekStart] = useState(() => startOfWeek());
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [agendaLoading, setAgendaLoading] = useState(true);
  const [appointmentDraft, setAppointmentDraft] = useState<AppointmentDraft | null>(null);
  const [machineSuggestions, setMachineSuggestions] = useState<MachineSummary[]>([]);
  const [machineContext, setMachineContext] = useState<MachineSummary | null>(null);
  const [lastHourmeter, setLastHourmeter] = useState<{ hourmeter: number; reading_date: string } | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [showTechnician, setShowTechnician] = useState(false);
  const [techName, setTechName] = useState('');
  const [techBranch, setTechBranch] = useState('');
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [retentionLoading, setRetentionLoading] = useState(false);
  const [retentionFutureClients, setRetentionFutureClients] = useState<Set<string>>(new Set());
  const [retentionSerials, setRetentionSerials] = useState<Record<string, string[]>>({});
  const [clientDetail, setClientDetail] = useState<ClientSummary | null>(null);
  const [clientMachines, setClientMachines] = useState<MachineSummary[]>([]);
  const [clientHistory, setClientHistory] = useState<HistoryRow[]>([]);
  const [clientDetailLoading, setClientDetailLoading] = useState(false);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [followupLoading, setFollowupLoading] = useState(false);
  const [followupDraft, setFollowupDraft] = useState<FollowupDraft | null>(null);
  const [followupError, setFollowupError] = useState('');
  const [insights, setInsights] = useState<Insight[]>([]);
  const [showInsights, setShowInsights] = useState(false);
  const selectedBranches = effectiveBranchValues(branch, branches);
  const defaultBranch = selectedBranches[0] || branches[0]?.name || '';

  useEffect(() => {
    setBranches(allowedBranches);
    setBranch(ALL);
    setTechBranch(allowedBranches[0]?.name || '');
  }, [allowedBranches]);

  const loadAgenda = useCallback(async () => {
    if (!branches.length) {
      setAgendaLoading(false);
      return;
    }
    setAgendaLoading(true);
    const end = addDays(weekStart, 5);
    const branchFilter = effectiveBranchValues(branch, branches);
    let tq = supabase.from('technicians').select('id,branch,name,active').eq('active', true).order('name');
    let aq = supabase.from('appointments').select('id,branch,appointment_date,technician_id,client_name,equipment_serial,service_city,status,service_reason,description,reported_hourmeter,forecast_amount,billing_status').gte('appointment_date', isoDate(weekStart)).lte('appointment_date', isoDate(end)).order('appointment_date');
    tq = tq.in('branch', branchFilter);
    aq = aq.in('branch', branchFilter);
    const [t, a] = await Promise.all([tq, aq]);
    setTechnicians((t.data || []) as Technician[]);
    setAppointments((a.data || []) as Appointment[]);
    setAgendaLoading(false);
  }, [branch, branches, weekStart]);
  useEffect(() => { loadAgenda(); }, [loadAgenda]);

  const loadInsights = useCallback(async () => {
    if (!branches.length) {
      setInsights([]);
      return;
    }
    const branchFilter = effectiveBranchValues(branch, branches);
    let q = supabase.from('ai_insights').select('id,appointment_id,branch,insight_type,priority,presentation_level,title,message,status,created_at').in('status', ['new', 'viewed']).order('created_at', { ascending: false }).limit(30);
    q = q.in('branch', branchFilter);
    const { data } = await q;
    setInsights((data || []) as Insight[]);
  }, [branch, branches]);
  useEffect(() => { loadInsights(); }, [loadInsights]);

  useEffect(() => {
    if (view !== 'retencao' || !branches.length) return;
    let cancelled = false;
    const branchFilter = effectiveBranchValues(branch, branches);

    async function loadRetention() {
      setRetentionLoading(true);

      async function fetchClients() {
        const rows: ClientSummary[] = [];
        for (let from = 0; ; from += RETENTION_PAGE_SIZE) {
          let query = supabase.from('g4_client_summary').select('*').order('last_service_at', { ascending: false }).range(from, from + RETENTION_PAGE_SIZE - 1);
          query = query.in('branch', branchFilter);
          const { data, error } = await query;
          if (error) throw error;
          const page = (data || []) as ClientSummary[];
          rows.push(...page);
          if (page.length < RETENTION_PAGE_SIZE) break;
        }
        return rows;
      }

      async function fetchFutureClients() {
        const rows: { client_name: string | null; branch: string }[] = [];
        for (let from = 0; ; from += RETENTION_PAGE_SIZE) {
          let query = supabase.from('appointments').select('client_name,branch').gte('appointment_date', isoDate(new Date())).not('client_name', 'is', null).order('appointment_date').range(from, from + RETENTION_PAGE_SIZE - 1);
          query = query.in('branch', branchFilter);
          const { data, error } = await query;
          if (error) throw error;
          const page = (data || []) as { client_name: string | null; branch: string }[];
          rows.push(...page);
          if (page.length < RETENTION_PAGE_SIZE) break;
        }
        return rows;
      }

      async function fetchMachines() {
        const rows: { serial: string; client_name: string | null; branch: string }[] = [];
        for (let from = 0; ; from += RETENTION_PAGE_SIZE) {
          let query = supabase.from('g4_machine_summary').select('serial,client_name,branch').not('client_name', 'is', null).order('serial').range(from, from + RETENTION_PAGE_SIZE - 1);
          query = query.in('branch', branchFilter);
          const { data, error } = await query;
          if (error) throw error;
          const page = (data || []) as { serial: string; client_name: string | null; branch: string }[];
          rows.push(...page);
          if (page.length < RETENTION_PAGE_SIZE) break;
        }
        return rows;
      }

      try {
        const [clientRows, futureRows, machineRows] = await Promise.all([fetchClients(), fetchFutureClients(), fetchMachines()]);
        if (cancelled) return;
        setClients(clientRows);
        setRetentionFutureClients(new Set(futureRows.map((row) => retentionKey(String(row.client_name || ''), String(row.branch || ''))).filter((key) => key !== '|')));
        const serials: Record<string, string[]> = {};
        for (const row of machineRows) {
          const clientName = String(row.client_name || '');
          const branchName = String(row.branch || '');
          const serial = String(row.serial || '').trim();
          if (!clientName || !branchName || !serial) continue;
          const key = retentionKey(clientName, branchName);
          if (!serials[key]) serials[key] = [];
          if (!serials[key].includes(serial)) serials[key].push(serial);
        }
        Object.values(serials).forEach((items) => items.sort((a, b) => a.localeCompare(b)));
        setRetentionSerials(serials);
      } catch (error) {
        console.error('retention_load_failed', error);
        if (!cancelled) {
          setClients([]);
          setRetentionSerials({});
          setRetentionFutureClients(new Set());
        }
      } finally {
        if (!cancelled) setRetentionLoading(false);
      }
    }

    void loadRetention();
    return () => { cancelled = true; };
  }, [view, branch, branches]);

  const loadFollowups = useCallback(async () => {
    if (!branches.length) {
      setFollowups([]);
      setFollowupLoading(false);
      return;
    }
    setFollowupLoading(true);
    const branchFilter = effectiveBranchValues(branch, branches);
    let q = supabase.from('followups').select('*').order('updated_at', { ascending: false }).limit(500);
    q = q.in('branch', branchFilter);
    const { data } = await q;
    setFollowups((data || []) as Followup[]);
    setFollowupLoading(false);
  }, [branch, branches]);

  useEffect(() => {
    if (view === 'followup' || view === 'inicio') void loadFollowups();
  }, [view, loadFollowups]);

  async function searchMachines(term: string, limit = 12) {
    const clean = term.trim();
    if (clean.length < 2 || !branches.length) return [];
    const branchFilter = effectiveBranchValues(branch, branches);
    let query = supabase.from('g4_machine_summary').select('*').limit(limit);
    query = query.in('branch', branchFilter);
    const pattern = `%${clean}%`;
    const { data } = await query.or(`serial.ilike.${pattern},client_name.ilike.${pattern},city.ilike.${pattern}`);
    return (data || []) as MachineSummary[];
  }

  useEffect(() => {
    if (!appointmentDraft) {
      setMachineSuggestions([]);
      setMachineContext(null);
      setLastHourmeter(null);
      return;
    }
    const term = appointmentDraft.equipment_serial.trim();
    if (term.length < 3 || machineContext?.serial === term) return;
    const timer = window.setTimeout(async () => setMachineSuggestions(await searchMachines(term, 8)), 180);
    return () => window.clearTimeout(timer);
  }, [appointmentDraft?.equipment_serial, branch, branches, machineContext?.serial]);

  async function selectMachine(machine: MachineSummary) {
    setMachineContext(machine);
    setMachineSuggestions([]);
    setAppointmentDraft((draft) => draft ? { ...draft, equipment_serial: machine.serial, client_name: machine.client_name || draft.client_name, service_city: machine.city || draft.service_city } : draft);
    const { data } = await supabase.from('hourmeter_readings').select('hourmeter,reading_date').eq('equipment_serial', machine.serial).order('reading_date', { ascending: false }).limit(1);
    setLastHourmeter((data || [])[0] as { hourmeter: number; reading_date: string } || null);
  }

  function changeAppointmentSerial(value: string) {
    setAppointmentDraft((draft) => draft ? { ...draft, equipment_serial: value } : draft);
    if (machineContext && machineContext.serial !== value) {
      setMachineContext(null);
      setLastHourmeter(null);
    }
  }

  function openNew(date: string, technicianId: string) {
    const tech = technicians.find((item) => item.id === technicianId);
    setFormError('');
    setMachineContext(null);
    setLastHourmeter(null);
    setAppointmentDraft(emptyAppointment(date, technicianId, tech?.branch || defaultBranch));
  }

  function openEdit(item: Appointment) {
    setFormError('');
    setMachineContext(null);
    setLastHourmeter(null);
    setAppointmentDraft({
      ...emptyAppointment(item.appointment_date, item.technician_id, item.branch),
      id: item.id,
      client_name: item.client_name || '',
      equipment_serial: item.equipment_serial || '',
      service_city: item.service_city || '',
      status: item.status,
      service_reason: item.service_reason || '',
      description: item.description || '',
      reported_hourmeter: item.reported_hourmeter == null ? '' : String(item.reported_hourmeter),
      forecast_amount: item.forecast_amount ? String(item.forecast_amount) : '',
      billing_status: item.billing_status,
    });
    if (item.equipment_serial) searchMachines(item.equipment_serial, 1).then((rows) => rows[0] && selectMachine(rows[0]));
  }

  function openHomeAppointment(item: Appointment) {
    const date = new Date(`${item.appointment_date}T12:00:00`);
    setWeekStart(startOfWeek(date));
    setView('agenda');
    openEdit(item);
  }

  function openHomeFollowup(item: Followup) {
    setView('followup');
    openFollowup(item);
  }

  async function triggerInsights(appointmentId: string, technicianId: string) {
    try {
      await supabase.functions.invoke('agenda-insights', { body: { appointment_id: appointmentId } });
      const start = isoDate(addDays(weekStart, -7));
      const end = isoDate(addDays(weekStart, 20));
      const { data } = await supabase.from('appointments').select('id').eq('technician_id', technicianId).gte('appointment_date', start).lte('appointment_date', end).neq('id', appointmentId).limit(12);
      for (const row of data || []) await supabase.functions.invoke('agenda-insights', { body: { appointment_id: row.id } });
      await loadInsights();
    } catch {
      // insights never block agenda
    }
  }

  async function saveAppointment(e: FormEvent) {
    e.preventDefault();
    if (!appointmentDraft) return;
    if (!appointmentDraft.branch || !appointmentDraft.appointment_date || !appointmentDraft.technician_id) {
      setFormError('Preencha data e técnico.');
      return;
    }
    setSaveBusy(true);
    setFormError('');
    const payload = {
      branch: appointmentDraft.branch,
      appointment_date: appointmentDraft.appointment_date,
      technician_id: appointmentDraft.technician_id,
      client_name: appointmentDraft.client_name.trim() || null,
      equipment_serial: appointmentDraft.equipment_serial.trim().toUpperCase() || null,
      service_city: appointmentDraft.service_city.trim() || null,
      status: appointmentDraft.status,
      service_reason: appointmentDraft.service_reason || null,
      description: appointmentDraft.description.trim() || null,
      reported_hourmeter: appointmentDraft.reported_hourmeter === '' ? null : Number(appointmentDraft.reported_hourmeter),
      forecast_amount: appointmentDraft.forecast_amount === '' ? 0 : Number(String(appointmentDraft.forecast_amount).replace(',', '.')),
      billing_status: appointmentDraft.billing_status,
    };
    const result = appointmentDraft.id
      ? await supabase.from('appointments').update(payload).eq('id', appointmentDraft.id).select('id,technician_id').single()
      : await supabase.from('appointments').insert(payload).select('id,technician_id').single();
    if (result.error) {
      setFormError(result.error.message);
      setSaveBusy(false);
      return;
    }
    setAppointmentDraft(null);
    setSaveBusy(false);
    await loadAgenda();
    if (result.data) void triggerInsights(result.data.id, result.data.technician_id);
  }

  async function deleteAppointment() {
    if (!appointmentDraft?.id) return;
    await supabase.from('appointments').delete().eq('id', appointmentDraft.id);
    setAppointmentDraft(null);
    await loadAgenda();
  }

  async function addTechnician(e: FormEvent) {
    e.preventDefault();
    if (!techName.trim() || !techBranch) return;
    const { error } = await supabase.from('technicians').insert({ branch: techBranch, name: techName.trim() });
    if (!error) {
      setTechName('');
      setShowTechnician(false);
      await loadAgenda();
    }
  }

  async function openClient(client: ClientSummary) {
    setClientDetail(client);
    setClientMachines([]);
    setClientHistory([]);
    setClientDetailLoading(true);
    const serials = retentionSerials[retentionKey(client.client_name, client.branch)] || [];
    let machinesQuery = supabase.from('g4_machine_summary').select('*').eq('branch', client.branch).order('last_service_at', { ascending: false }).limit(100);
    if (serials.length) machinesQuery = machinesQuery.in('serial', serials);
    else machinesQuery = machinesQuery.ilike('client_name', client.client_name);
    const historyQuery = supabase.from('g4_history_app').select('*').eq('branch', client.branch).ilike('client_name', client.client_name).order('service_date', { ascending: false }).limit(80);
    const [machinesResponse, historyResponse] = await Promise.all([machinesQuery, historyQuery]);
    setClientMachines((machinesResponse.data || []) as MachineSummary[]);
    setClientHistory((historyResponse.data || []) as HistoryRow[]);
    setClientDetailLoading(false);
  }

  function scheduleFromRetention(client: ClientSummary, serial: string, technicianId: string) {
    const technician = technicians.find((item) => item.id === technicianId);
    const draft = emptyAppointment(isoDate(new Date()), technician?.id || '', technician?.branch || client.branch);
    setFormError('');
    setMachineContext(null);
    setLastHourmeter(null);
    setClientDetail(null);
    setAppointmentDraft({ ...draft, client_name: client.client_name, equipment_serial: serial || '', service_city: client.city || '' });
    if (serial) searchMachines(serial, 1).then((rows) => rows[0] && selectMachine(rows[0]));
  }

  function openFollowup(item: Followup) {
    setFollowupError('');
    setFollowupDraft(followupToDraft(item));
  }

  async function newFollowup(client?: ClientSummary) {
    setFollowupError('');
    if (client) {
      const { data } = await supabase
        .from('followups')
        .select('*')
        .eq('branch', client.branch)
        .ilike('client_name', client.client_name)
        .neq('stage', 'encerrar')
        .order('updated_at', { ascending: false })
        .limit(1);
      const existing = (data || [])[0] as Followup | undefined;
      if (existing) {
        openFollowup(existing);
        return;
      }
      const serials = retentionSerials[retentionKey(client.client_name, client.branch)] || [];
      setFollowupDraft({
        ...emptyFollowup(client.branch),
        client_name: client.client_name,
        equipment_serial: serials.length === 1 ? serials[0] : '',
      });
      return;
    }
    setFollowupDraft(emptyFollowup(defaultBranch));
  }

  async function saveFollowup(e: FormEvent) {
    e.preventDefault();
    if (!followupDraft?.client_name.trim()) return;
    setFollowupError('');

    if (followupDraft.stage === 'encerrar' && !followupDraft.result) {
      setFollowupError('Selecione Venda ganha ou Venda perdida.');
      return;
    }
    if (followupDraft.result === 'venda_ganha' && !followupDraft.sale_kind) {
      setFollowupError('Informe se a venda foi de peças, serviços ou ambos.');
      return;
    }

    const payload = {
      branch: followupDraft.branch,
      client_name: followupDraft.client_name.trim(),
      equipment_serial: followupDraft.equipment_serial.trim().toUpperCase() || null,
      stage: followupDraft.stage,
      next_followup_date: followupDraft.stage === 'encerrar' ? null : (followupDraft.next_followup_date || null),
      notes: followupDraft.notes.trim() || null,
      result: followupDraft.stage === 'encerrar' ? (followupDraft.result || null) : null,
      sale_kind: followupDraft.result === 'venda_ganha' ? (followupDraft.sale_kind || null) : null,
      parts_value: followupDraft.result === 'venda_ganha' && (followupDraft.sale_kind === 'pecas' || followupDraft.sale_kind === 'pecas_servicos') ? parseMoney(followupDraft.parts_value) : null,
      services_value: followupDraft.result === 'venda_ganha' && (followupDraft.sale_kind === 'servicos' || followupDraft.sale_kind === 'pecas_servicos') ? parseMoney(followupDraft.services_value) : null,
      updated_by_matricula: user.matricula,
      updated_by_name: user.name,
    };

    const response = followupDraft.id
      ? await supabase.from('followups').update(payload).eq('id', followupDraft.id)
      : await supabase.from('followups').insert({ ...payload, created_by_matricula: user.matricula, created_by_name: user.name });

    if (response.error) {
      if (response.error.code === '23505') {
        const { data } = await supabase.from('followups').select('*').eq('branch', followupDraft.branch).ilike('client_name', followupDraft.client_name.trim()).neq('stage', 'encerrar').order('updated_at', { ascending: false }).limit(1);
        const existing = (data || [])[0] as Followup | undefined;
        if (existing) {
          setFollowupError('Esse cliente já possui uma tratativa aberta. Ela foi carregada para você.');
          setFollowupDraft(followupToDraft(existing));
          return;
        }
      }
      setFollowupError(response.error.message);
      return;
    }

    setFollowupDraft(null);
    setFollowupError('');
    if (view === 'followup' || view === 'inicio') await loadFollowups();
  }

  async function feedbackInsight(id: string, status: 'viewed' | 'ignored' | 'useful') {
    await supabase.from('ai_insights').update({ status }).eq('id', id);
    await loadInsights();
  }

  function changeView(next: ViewName) {
    if (next === 'inicio') setWeekStart(startOfWeek());
    setView(next);
  }

  return <div className="app-shell">
    <Sidebar view={view} onView={changeView} />
    <div className="workspace">
      <Topbar view={view} branches={branches} branch={branch} onBranch={setBranch} insights={insights} onBell={() => setShowInsights(true)} />
      <main className="content">
        {view === 'inicio' && <HomeView appointments={appointments} technicians={technicians} followups={followups} loading={agendaLoading || followupLoading} consultantName={user.name} consultantMatricula={user.matricula} onAppointment={openHomeAppointment} onFollowup={openHomeFollowup} />}
        {view === 'agenda' && <AgendaView weekStart={weekStart} onWeek={(date) => setWeekStart(startOfWeek(date))} technicians={technicians} appointments={appointments} loading={agendaLoading} onNew={openNew} onEdit={openEdit} onAddTechnician={() => setShowTechnician(true)} />}
        {view === 'retencao' && <RetentionView clients={clients} loading={retentionLoading} futureClients={retentionFutureClients} serialsByClient={retentionSerials} appointments={appointments} technicians={technicians} weekStart={weekStart} onFollowup={(client) => { void newFollowup(client); }} onOpen={openClient} onSchedule={scheduleFromRetention} />}
        {view === 'followup' && <FollowupView rows={followups} loading={followupLoading} onNew={() => { void newFollowup(); }} onEdit={openFollowup} />}
      </main>
    </div>
    <AppointmentDrawer draft={appointmentDraft} setDraft={setAppointmentDraft} technicians={technicians} suggestions={machineSuggestions} machineContext={machineContext} lastHourmeter={lastHourmeter} formError={formError} saveBusy={saveBusy} onSubmit={saveAppointment} onClose={() => setAppointmentDraft(null)} onDelete={deleteAppointment} onSelectMachine={selectMachine} onSerialChange={changeAppointmentSerial} />
    <TechnicianDrawer open={showTechnician} name={techName} branch={techBranch} branches={branches} onName={setTechName} onBranch={setTechBranch} onClose={() => setShowTechnician(false)} onSubmit={addTechnician} />
    <ClientDetailDrawer client={clientDetail} machines={clientMachines} history={clientHistory} loading={clientDetailLoading} onClose={() => setClientDetail(null)} onCreateFollowup={(client) => { setClientDetail(null); void newFollowup(client); }} />
    <FollowupDrawer draft={followupDraft} setDraft={setFollowupDraft} branches={branches} error={followupError} onClose={() => { setFollowupDraft(null); setFollowupError(''); }} onSubmit={saveFollowup} />
    <InsightsDrawer open={showInsights} insights={insights} onClose={() => setShowInsights(false)} onFeedback={feedbackInsight} />
  </div>;
}
