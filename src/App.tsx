import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { AppointmentDrawer } from './components/AppointmentDrawer';
import { TechnicianDrawer } from './components/TechnicianDrawer';
import { MachineDetailDrawer } from './components/MachineDetailDrawer';
import { FollowupDrawer } from './components/FollowupDrawer';
import { InsightsDrawer } from './components/InsightsDrawer';
import { AgendaView } from './features/AgendaView';
import { RetentionView } from './features/RetentionView';
import { EquipmentView } from './features/EquipmentView';
import { FollowupView } from './features/FollowupView';
import { supabase } from './lib/supabase';
import { addDays, isoDate, startOfWeek } from './lib/date';
import { emptyAppointment } from './drafts';
import type { AppointmentDraft, FollowupDraft } from './drafts';
import type { Appointment, Branch, ClientSummary, Followup, HistoryRow, Insight, MachineSummary, Technician, ViewName } from './types';
import './styles.css';

const ALL = '__all__';
const retentionKey = (clientName: string, branchName: string) => `${clientName.trim().toUpperCase()}|${branchName.trim().toUpperCase()}`;

export default function App() {
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
  const [equipmentResults, setEquipmentResults] = useState<MachineSummary[]>([]);
  const [equipmentLoading, setEquipmentLoading] = useState(false);
  const [machineDetail, setMachineDetail] = useState<MachineSummary | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [followupLoading, setFollowupLoading] = useState(false);
  const [followupDraft, setFollowupDraft] = useState<FollowupDraft | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [showInsights, setShowInsights] = useState(false);

  useEffect(() => { supabase.from('app_branches').select('name').eq('active', true).order('name').then(({ data }) => { const rows = (data || []) as Branch[]; setBranches(rows); if (rows[0]) setTechBranch(rows[0].name); }); }, []);

  const loadAgenda = useCallback(async () => {
    setAgendaLoading(true);
    const end = addDays(weekStart, 5);
    let tq = supabase.from('technicians').select('id,branch,name,active').eq('active', true).order('name');
    let aq = supabase.from('appointments').select('id,branch,appointment_date,technician_id,client_name,equipment_serial,service_city,status,service_reason,description,reported_hourmeter,forecast_amount,billing_status').gte('appointment_date', isoDate(weekStart)).lte('appointment_date', isoDate(end)).order('appointment_date');
    if (branch !== ALL) { tq = tq.eq('branch', branch); aq = aq.eq('branch', branch); }
    const [t, a] = await Promise.all([tq, aq]);
    setTechnicians((t.data || []) as Technician[]); setAppointments((a.data || []) as Appointment[]); setAgendaLoading(false);
  }, [branch, weekStart]);
  useEffect(() => { loadAgenda(); }, [loadAgenda]);

  const loadInsights = useCallback(async () => {
    let q = supabase.from('ai_insights').select('id,appointment_id,branch,insight_type,priority,presentation_level,title,message,status,created_at').in('status', ['new','viewed']).order('created_at', { ascending: false }).limit(30);
    if (branch !== ALL) q = q.eq('branch', branch);
    const { data } = await q; setInsights((data || []) as Insight[]);
  }, [branch]);
  useEffect(() => { loadInsights(); }, [loadInsights]);

  useEffect(() => {
    if (view !== 'retencao') return;
    setRetentionLoading(true);
    let clientQuery = supabase.from('g4_client_summary').select('*').order('last_service_at', { ascending: false }).limit(5000);
    let futureQuery = supabase.from('appointments').select('client_name,branch').gte('appointment_date', isoDate(new Date())).not('client_name', 'is', null).limit(5000);
    let machineQuery = supabase.from('g4_machine_summary').select('serial,client_name,branch').not('client_name', 'is', null).limit(5000);
    if (branch !== ALL) {
      clientQuery = clientQuery.eq('branch', branch);
      futureQuery = futureQuery.eq('branch', branch);
      machineQuery = machineQuery.eq('branch', branch);
    }
    Promise.all([clientQuery, futureQuery, machineQuery]).then(([clientsResponse, futureResponse, machineResponse]) => {
      setClients((clientsResponse.data || []) as ClientSummary[]);
      setRetentionFutureClients(new Set((futureResponse.data || []).map((row: any) => retentionKey(String(row.client_name || ''), String(row.branch || ''))).filter((key) => key !== '|')));
      const serials: Record<string, string[]> = {};
      for (const row of machineResponse.data || []) {
        const clientName = String((row as any).client_name || '');
        const branchName = String((row as any).branch || '');
        const serial = String((row as any).serial || '').trim();
        if (!clientName || !branchName || !serial) continue;
        const key = retentionKey(clientName, branchName);
        if (!serials[key]) serials[key] = [];
        if (!serials[key].includes(serial)) serials[key].push(serial);
      }
      Object.values(serials).forEach((items) => items.sort((a, b) => a.localeCompare(b)));
      setRetentionSerials(serials);
      setRetentionLoading(false);
    });
  }, [view, branch]);

  useEffect(() => {
    if (view !== 'followup') return;
    setFollowupLoading(true);
    let q = supabase.from('followups').select('*').order('action_date', { ascending: false }).limit(500);
    if (branch !== ALL) q = q.eq('branch', branch);
    q.then(({ data }) => { setFollowups((data || []) as Followup[]); setFollowupLoading(false); });
  }, [view, branch]);

  async function searchMachines(term: string, limit = 12) {
    const clean = term.trim(); if (clean.length < 2) return [];
    let query = supabase.from('g4_machine_summary').select('*').limit(limit);
    if (branch !== ALL) query = query.eq('branch', branch);
    const pattern = `%${clean}%`;
    const { data } = await query.or(`serial.ilike.${pattern},client_name.ilike.${pattern},city.ilike.${pattern}`);
    return (data || []) as MachineSummary[];
  }

  useEffect(() => {
    if (!appointmentDraft) { setMachineSuggestions([]); setMachineContext(null); setLastHourmeter(null); return; }
    const term = appointmentDraft.equipment_serial.trim();
    if (term.length < 3 || machineContext?.serial === term) return;
    const timer = window.setTimeout(async () => setMachineSuggestions(await searchMachines(term, 8)), 180);
    return () => window.clearTimeout(timer);
  }, [appointmentDraft?.equipment_serial, branch, machineContext?.serial]);

  async function selectMachine(machine: MachineSummary) {
    setMachineContext(machine); setMachineSuggestions([]);
    setAppointmentDraft((d) => d ? { ...d, equipment_serial: machine.serial, client_name: machine.client_name || d.client_name, service_city: machine.city || d.service_city } : d);
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

  function openNew(date: string, technicianId: string) { const tech = technicians.find((t) => t.id === technicianId); setFormError(''); setMachineContext(null); setLastHourmeter(null); setAppointmentDraft(emptyAppointment(date, technicianId, tech?.branch || (branch === ALL ? branches[0]?.name || '' : branch))); }
  function openEdit(item: Appointment) {
    setFormError(''); setMachineContext(null); setLastHourmeter(null);
    setAppointmentDraft({ ...emptyAppointment(item.appointment_date, item.technician_id, item.branch), id: item.id, client_name: item.client_name || '', equipment_serial: item.equipment_serial || '', service_city: item.service_city || '', status: item.status, service_reason: item.service_reason || '', description: item.description || '', reported_hourmeter: item.reported_hourmeter == null ? '' : String(item.reported_hourmeter), forecast_amount: item.forecast_amount ? String(item.forecast_amount) : '', billing_status: item.billing_status });
    if (item.equipment_serial) searchMachines(item.equipment_serial, 1).then((rows) => rows[0] && selectMachine(rows[0]));
  }

  async function triggerInsights(appointmentId: string, technicianId: string) {
    try {
      await supabase.functions.invoke('agenda-insights', { body: { appointment_id: appointmentId } });
      const start = isoDate(addDays(weekStart, -7)); const end = isoDate(addDays(weekStart, 20));
      const { data } = await supabase.from('appointments').select('id').eq('technician_id', technicianId).gte('appointment_date', start).lte('appointment_date', end).neq('id', appointmentId).limit(12);
      for (const row of data || []) await supabase.functions.invoke('agenda-insights', { body: { appointment_id: row.id } });
      await loadInsights();
    } catch { /* insights never block agenda */ }
  }

  async function saveAppointment(e: FormEvent) {
    e.preventDefault(); if (!appointmentDraft) return;
    if (!appointmentDraft.branch || !appointmentDraft.appointment_date || !appointmentDraft.technician_id) { setFormError('Preencha data e técnico.'); return; }
    setSaveBusy(true); setFormError('');
    const payload = { branch: appointmentDraft.branch, appointment_date: appointmentDraft.appointment_date, technician_id: appointmentDraft.technician_id, client_name: appointmentDraft.client_name.trim() || null, equipment_serial: appointmentDraft.equipment_serial.trim().toUpperCase() || null, service_city: appointmentDraft.service_city.trim() || null, status: appointmentDraft.status, service_reason: appointmentDraft.service_reason || null, description: appointmentDraft.description.trim() || null, reported_hourmeter: appointmentDraft.reported_hourmeter === '' ? null : Number(appointmentDraft.reported_hourmeter), forecast_amount: appointmentDraft.forecast_amount === '' ? 0 : Number(String(appointmentDraft.forecast_amount).replace(',', '.')), billing_status: appointmentDraft.billing_status };
    const result = appointmentDraft.id ? await supabase.from('appointments').update(payload).eq('id', appointmentDraft.id).select('id,technician_id').single() : await supabase.from('appointments').insert(payload).select('id,technician_id').single();
    if (result.error) { setFormError(result.error.message); setSaveBusy(false); return; }
    setAppointmentDraft(null); setSaveBusy(false); await loadAgenda(); if (result.data) void triggerInsights(result.data.id, result.data.technician_id);
  }
  async function deleteAppointment() { if (!appointmentDraft?.id) return; await supabase.from('appointments').delete().eq('id', appointmentDraft.id); setAppointmentDraft(null); await loadAgenda(); }

  async function addTechnician(e: FormEvent) { e.preventDefault(); if (!techName.trim() || !techBranch) return; const { error } = await supabase.from('technicians').insert({ branch: techBranch, name: techName.trim() }); if (!error) { setTechName(''); setShowTechnician(false); await loadAgenda(); } }
  async function equipmentSearch(term: string) { setEquipmentLoading(true); setEquipmentResults(await searchMachines(term, 60)); setEquipmentLoading(false); }
  async function openMachine(machine: MachineSummary) { setMachineDetail(machine); setHistory([]); const { data } = await supabase.from('g4_history_app').select('*').eq('serial', machine.serial).order('service_date', { ascending: false }).limit(12); setHistory((data || []) as HistoryRow[]); }

  function newFollowup(client?: ClientSummary) { setFollowupDraft({ branch: client?.branch || (branch === ALL ? branches[0]?.name || '' : branch), client_name: client?.client_name || '', equipment_serial: '', action_date: isoDate(new Date()), treatment_type: 'retorno', status: 'contato_realizado', estimated_value: '', next_followup_date: '', notes: '' }); }
  async function saveFollowup(e: FormEvent) {
    e.preventDefault(); if (!followupDraft?.client_name.trim()) return;
    const payload = { ...followupDraft, client_name: followupDraft.client_name.trim(), equipment_serial: followupDraft.equipment_serial.trim() || null, estimated_value: followupDraft.estimated_value ? Number(followupDraft.estimated_value.replace(',', '.')) : null, next_followup_date: followupDraft.next_followup_date || null, notes: followupDraft.notes.trim() || null };
    const { error } = await supabase.from('followups').insert(payload); if (!error) { setFollowupDraft(null); if (view === 'followup') { setFollowupLoading(true); const { data } = await supabase.from('followups').select('*').order('action_date', { ascending: false }); setFollowups((data || []) as Followup[]); setFollowupLoading(false); } }
  }
  async function feedbackInsight(id: string, status: 'viewed'|'ignored'|'useful') { await supabase.from('ai_insights').update({ status }).eq('id', id); await loadInsights(); }

  return <div className="app-shell"><Sidebar view={view} onView={setView} /><div className="workspace"><Topbar view={view} branches={branches} branch={branch} onBranch={setBranch} insights={insights} onBell={() => setShowInsights(true)} /><main className="content">{view === 'agenda' && <AgendaView weekStart={weekStart} onWeek={(d) => setWeekStart(startOfWeek(d))} technicians={technicians} appointments={appointments} loading={agendaLoading} onNew={openNew} onEdit={openEdit} onAddTechnician={() => setShowTechnician(true)} />}{view === 'retencao' && <RetentionView clients={clients} loading={retentionLoading} futureClients={retentionFutureClients} serialsByClient={retentionSerials} onFollowup={(client) => newFollowup(client)} />}{view === 'equipamentos' && <EquipmentView results={equipmentResults} loading={equipmentLoading} onSearch={equipmentSearch} onOpen={openMachine} />}{view === 'followup' && <FollowupView rows={followups} loading={followupLoading} onNew={() => newFollowup()} />}</main></div>
    <AppointmentDrawer draft={appointmentDraft} setDraft={setAppointmentDraft} technicians={technicians} suggestions={machineSuggestions} machineContext={machineContext} lastHourmeter={lastHourmeter} formError={formError} saveBusy={saveBusy} onSubmit={saveAppointment} onClose={() => setAppointmentDraft(null)} onDelete={deleteAppointment} onSelectMachine={selectMachine} onSerialChange={changeAppointmentSerial} />
    <TechnicianDrawer open={showTechnician} name={techName} branch={techBranch} branches={branches} onName={setTechName} onBranch={setTechBranch} onClose={() => setShowTechnician(false)} onSubmit={addTechnician} />
    <MachineDetailDrawer machine={machineDetail} history={history} onClose={() => setMachineDetail(null)} />
    <FollowupDrawer draft={followupDraft} setDraft={setFollowupDraft} branches={branches} onClose={() => setFollowupDraft(null)} onSubmit={saveFollowup} />
    <InsightsDrawer open={showInsights} insights={insights} onClose={() => setShowInsights(false)} onFeedback={feedbackInsight} />
  </div>;
}
