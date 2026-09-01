import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Map, Plus, X } from 'lucide-react';
import type { Appointment, ClientSummary, Technician } from '../types';
import { addDays, isoDate, startOfWeek } from '../lib/date';
import { supabase } from '../lib/supabase';
import { APPOINTMENT_TYPE_LEGEND, appointmentTypeStyle } from './appointmentTypes';
import { RetentionMap } from './RetentionMap';
import type { RecencyBucket } from './retentionRecency';
import './agenda-colors.css';

const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
const dayDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const fullDayDate = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
const monthTitle = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

type AgendaRange = 'today' | 'week' | 'fortnight' | 'month';

const statusClass: Record<string, string> = {
  planejado: 'status-plan', confirmado: 'status-confirm', em_atendimento: 'status-progress', concluido: 'status-done', cancelado: 'status-cancel',
};

function firstOfMonth(input: Date) {
  const date = new Date(input);
  date.setDate(1);
  date.setHours(12, 0, 0, 0);
  return date;
}

function addMonths(input: Date, amount: number) {
  const date = firstOfMonth(input);
  date.setMonth(date.getMonth() + amount);
  return date;
}

function daysForRange(range: AgendaRange, anchor: Date) {
  if (range === 'today') return [new Date(anchor)];

  if (range === 'week' || range === 'fortnight') {
    const start = startOfWeek(anchor);
    const calendarDays = range === 'week' ? 7 : 14;
    return Array.from({ length: calendarDays }, (_, index) => addDays(start, index))
      .filter((date) => date.getDay() !== 0);
  }

  const start = firstOfMonth(anchor);
  const month = start.getMonth();
  const days: Date[] = [];
  for (let cursor = new Date(start); cursor.getMonth() === month; cursor = addDays(cursor, 1)) {
    if (cursor.getDay() !== 0) days.push(new Date(cursor));
  }
  return days;
}

export function AgendaView({ weekStart, onWeek, technicians, appointments, clients, serialsByClient, loading, onNew, onEdit, onAddTechnician, onOpenClient, onFollowup, onSchedule }: {
  weekStart: Date;
  onWeek: (date: Date) => void;
  technicians: Technician[];
  appointments: Appointment[];
  clients: ClientSummary[];
  serialsByClient: Record<string, string[]>;
  loading: boolean;
  onNew: (date: string, technicianId: string) => void;
  onEdit: (appointment: Appointment) => void;
  onAddTechnician: () => void;
  onOpenClient: (client: ClientSummary) => void;
  onFollowup: (client: ClientSummary) => void;
  onSchedule: (client: ClientSummary, serial: string, technicianId: string) => void;
}) {
  const [range, setRange] = useState<AgendaRange>('week');
  const [anchorDate, setAnchorDate] = useState(() => startOfWeek(weekStart));
  const [mode, setMode] = useState<'agenda' | 'map'>('agenda');
  const [mapRecency, setMapRecency] = useState<RecencyBucket | null>(null);
  const [periodAppointments, setPeriodAppointments] = useState<Appointment[]>(appointments);
  const [periodLoading, setPeriodLoading] = useState(false);
  const [localCopies, setLocalCopies] = useState<Appointment[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [reasonFilters, setReasonFilters] = useState<string[]>([]);

  useEffect(() => {
    if (range === 'week') setAnchorDate(startOfWeek(weekStart));
  }, [weekStart, range]);

  const days = useMemo(() => daysForRange(range, anchorDate), [range, anchorDate]);
  const periodStart = days[0] || anchorDate;
  const periodEnd = days[days.length - 1] || anchorDate;
  const periodStartIso = isoDate(periodStart);
  const periodEndIso = isoDate(periodEnd);

  const title = range === 'today'
    ? fullDayDate.format(periodStart).replace(/^./, (letter) => letter.toUpperCase())
    : range === 'month'
      ? monthTitle.format(periodStart).replace(/^./, (letter) => letter.toUpperCase())
      : `${dayDate.format(periodStart)} — ${dayDate.format(periodEnd)}`;

  const columnMin = range === 'today' ? 360 : 150;
  const gridMinWidth = Math.max(720, 180 + days.length * columnMin);
  const gridStyle = {
    gridTemplateColumns: `180px repeat(${Math.max(days.length, 1)}, minmax(${columnMin}px, 1fr))`,
    minWidth: `${gridMinWidth}px`,
  };

  useEffect(() => {
    let cancelled = false;
    const technicianIds = technicians.map((item) => item.id);

    async function loadPeriodAppointments() {
      if (!technicianIds.length || !days.length) {
        if (!cancelled) {
          setPeriodAppointments([]);
          setPeriodLoading(false);
        }
        return;
      }

      setPeriodLoading(true);
      const { data, error } = await supabase
        .from('appointments')
        .select('id,branch,appointment_date,technician_id,client_name,equipment_serial,service_city,status,service_reason,description,reported_hourmeter,forecast_amount,billing_status')
        .in('technician_id', technicianIds)
        .gte('appointment_date', periodStartIso)
        .lte('appointment_date', periodEndIso)
        .order('appointment_date');

      if (cancelled) return;
      if (error) {
        const visibleDates = new Set(days.map(isoDate));
        setPeriodAppointments(appointments.filter((item) => visibleDates.has(item.appointment_date)));
      } else {
        setPeriodAppointments((data || []) as Appointment[]);
      }
      setPeriodLoading(false);
    }

    void loadPeriodAppointments();
    return () => { cancelled = true; };
  }, [periodStartIso, periodEndIso, technicians, appointments, days.length]);

  useEffect(() => { setLocalCopies([]); }, [range, periodStartIso, periodEndIso]);

  const allAppointments = useMemo(() => {
    const known = new Set(periodAppointments.map((item) => item.id));
    return [...periodAppointments, ...localCopies.filter((item) => !known.has(item.id))];
  }, [periodAppointments, localCopies]);

  const visibleAppointments = useMemo(() => reasonFilters.length
    ? allAppointments.filter((item) => reasonFilters.includes(item.service_reason || ''))
    : allAppointments, [allAppointments, reasonFilters]);
  const forecast = visibleAppointments.reduce((sum, item) => sum + Number(item.forecast_amount || 0), 0);
  const dragged = draggedId ? allAppointments.find((item) => item.id === draggedId) || null : null;

  function toggleReasonFilter(reason: string) {
    setReasonFilters((current) => current.includes(reason) ? current.filter((item) => item !== reason) : [...current, reason]);
  }

  function changeRange(next: AgendaRange) {
    setRange(next);
    if (next === 'today') {
      setAnchorDate(new Date());
      return;
    }
    if (next === 'month') {
      setAnchorDate(firstOfMonth(anchorDate));
      return;
    }
    const start = startOfWeek(anchorDate);
    setAnchorDate(start);
    if (next === 'week') onWeek(start);
  }

  function movePeriod(direction: -1 | 1) {
    let next: Date;
    if (range === 'today') next = addDays(anchorDate, direction);
    else if (range === 'week') next = addDays(startOfWeek(anchorDate), direction * 7);
    else if (range === 'fortnight') next = addDays(startOfWeek(anchorDate), direction * 14);
    else next = addMonths(anchorDate, direction);
    setAnchorDate(next);
    if (range === 'week') onWeek(next);
  }

  async function copyAppointment(source: Appointment, targetDate: string, targetTechnicianId: string) {
    if (copying || source.appointment_date === targetDate || source.technician_id !== targetTechnicianId) return;
    const tech = technicians.find((item) => item.id === targetTechnicianId);
    if (!tech) return;
    setCopying(true);
    const payload = {
      branch: tech.branch,
      appointment_date: targetDate,
      technician_id: targetTechnicianId,
      client_name: source.client_name,
      equipment_serial: source.equipment_serial,
      service_city: source.service_city,
      status: source.status,
      service_reason: source.service_reason,
      description: source.description,
      reported_hourmeter: null,
      forecast_amount: source.forecast_amount || 0,
      billing_status: source.billing_status,
    };
    const { data, error } = await supabase
      .from('appointments')
      .insert(payload)
      .select('id,branch,appointment_date,technician_id,client_name,equipment_serial,service_city,status,service_reason,description,reported_hourmeter,forecast_amount,billing_status')
      .single();
    if (!error && data) {
      const inserted = data as Appointment;
      setLocalCopies((current) => [...current, inserted]);
      void supabase.functions.invoke('agenda-insights', { body: { appointment_id: inserted.id } });
    }
    setCopying(false);
    setDraggedId(null);
    setDropTarget(null);
  }

  return <div className="agenda-view">
    <div className="agenda-toolbar">
      <div><strong>{title}</strong><span>{visibleAppointments.length} atendimento{visibleAppointments.length === 1 ? '' : 's'} · {money.format(forecast)}{reasonFilters.length ? ` · ${reasonFilters.length} filtro${reasonFilters.length === 1 ? '' : 's'}` : ''}</span></div>
      <div className="toolbar-actions">
        <div className="agenda-view-tabs" aria-label="Visualização da agenda">
          <button type="button" className={mode === 'agenda' ? 'active' : ''} onClick={() => setMode('agenda')}><CalendarDays size={15}/> Agenda</button>
          <button type="button" className={mode === 'map' ? 'active' : ''} onClick={() => setMode('map')}><Map size={15}/> Mapa</button>
        </div>
        <div className="agenda-range-tabs" aria-label="Período da agenda">
          <button type="button" className={range === 'today' ? 'active' : ''} onClick={() => changeRange('today')}>Hoje</button>
          <button type="button" className={range === 'week' ? 'active' : ''} onClick={() => changeRange('week')}>Semanal</button>
          <button type="button" className={range === 'fortnight' ? 'active' : ''} onClick={() => changeRange('fortnight')}>Quinzenal</button>
          <button type="button" className={range === 'month' ? 'active' : ''} onClick={() => changeRange('month')}>Mensal</button>
        </div>
        <button className="icon-button" type="button" onClick={() => movePeriod(-1)} aria-label="Período anterior"><ChevronLeft size={18} /></button>
        <button className="icon-button" type="button" onClick={() => movePeriod(1)} aria-label="Próximo período"><ChevronRight size={18} /></button>
        <button className="primary-button" onClick={onAddTechnician}><Plus size={17} /> Técnico</button>
      </div>
    </div>

    {mode === 'agenda' && <>
      <div className="agenda-type-legend" aria-label="Filtros por tipo de atendimento">
        {APPOINTMENT_TYPE_LEGEND.map((item) => {
          const active = reasonFilters.includes(item.label);
          return <button type="button" aria-pressed={active} className={`agenda-type-legend-item ${active ? 'active' : ''}`} key={item.label} onClick={() => toggleReasonFilter(item.label)}><i className="agenda-type-swatch" style={{ background: item.color }} />{item.label}</button>;
        })}
        {reasonFilters.length > 0 && <button type="button" className="agenda-type-clear" onClick={() => setReasonFilters([])}><X size={12}/> Limpar filtro</button>}
      </div>

      <div className="agenda-shell agenda-week-fit">
        <div className="agenda-grid agenda-head" style={gridStyle}>
          <div className="tech-col">Técnico</div>
          {days.map((day) => <div key={isoDate(day)} className="day-head"><span>{dayName.format(day).replace('.', '')}</span><strong>{dayDate.format(day)}</strong></div>)}
        </div>
        {loading || periodLoading ? <div className="agenda-loading">Carregando agenda...</div> : technicians.length === 0 ? <div className="agenda-empty"><strong>Nenhum técnico cadastrado.</strong><span>Adicione o primeiro técnico para começar a montar a agenda.</span><button className="primary-button" onClick={onAddTechnician}><Plus size={17}/> Adicionar técnico</button></div> : technicians.map((tech) => (
          <div className="agenda-grid agenda-row" style={gridStyle} key={tech.id}>
            <div className="tech-col tech-name"><strong>{tech.name}</strong><span>{tech.branch}</span></div>
            {days.map((day) => {
              const date = isoDate(day);
              const cellKey = `${tech.id}|${date}`;
              const allCellItems = allAppointments.filter((item) => item.technician_id === tech.id && item.appointment_date === date);
              const items = visibleAppointments.filter((item) => item.technician_id === tech.id && item.appointment_date === date);
              const canDrop = Boolean(dragged && dragged.technician_id === tech.id && dragged.appointment_date !== date);
              return <div
                className={`day-cell ${dropTarget === cellKey && canDrop ? 'copy-drop-target' : ''}`}
                key={date}
                onClick={() => allCellItems.length === 0 && !draggedId && onNew(date, tech.id)}
                onDragOver={(event) => { if (!canDrop) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropTarget(cellKey); }}
                onDragLeave={() => dropTarget === cellKey && setDropTarget(null)}
                onDrop={(event) => { event.preventDefault(); if (dragged && canDrop) void copyAppointment(dragged, date, tech.id); }}
              >
                {allCellItems.length === 0 ? <button className="cell-add" onClick={(e) => { e.stopPropagation(); onNew(date, tech.id); }}><Plus size={16}/></button> : items.map((item) => {
                  const typeStyle = appointmentTypeStyle(item.service_reason);
                  const hasForecast = Number(item.forecast_amount || 0) > 0;
                  return <button
                    key={item.id}
                    draggable
                    className={`appointment-card ${statusClass[item.status] || ''} ${draggedId === item.id ? 'copy-dragging' : ''}`}
                    style={{ background: typeStyle.background, borderLeftColor: typeStyle.color }}
                    onDragStart={(event) => { setDraggedId(item.id); event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('text/plain', item.id); }}
                    onDragEnd={() => { setDraggedId(null); setDropTarget(null); }}
                    onClick={(e) => { e.stopPropagation(); if (!draggedId) onEdit(item); }}
                    title="Arraste para outro dia da mesma linha para copiar"
                  >
                    <strong>{item.client_name || item.service_reason || 'Atendimento'}</strong>
                    <span>{item.service_city || 'Cidade não informada'}</span>
                    <small className="appointment-card-reason">{item.service_reason || 'Motivo não informado'}{item.equipment_serial ? ` · ${item.equipment_serial}` : ''}</small>
                    {hasForecast && <small className="appointment-card-revenue">Faturamento: <b>{money.format(Number(item.forecast_amount))}</b></small>}
                  </button>;
                })}
                {copying && dropTarget === cellKey && <span className="copying-label">Copiando...</span>}
              </div>;
            })}
          </div>
        ))}
      </div>
    </>}

    {mode === 'map' && <div className="agenda-map-tab">
      <RetentionMap
        clients={clients}
        serialsByClient={serialsByClient}
        appointments={visibleAppointments}
        technicians={technicians}
        weekLabel={title}
        recencyFilter={mapRecency}
        onRecencyFilter={setMapRecency}
        onOpen={onOpenClient}
        onFollowup={onFollowup}
        onSchedule={onSchedule}
      />
    </div>}
  </div>;
}
