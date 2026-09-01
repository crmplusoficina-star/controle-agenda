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
const monthTitle = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
const fullDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const statusClass: Record<string, string> = {
  planejado: 'status-plan', confirmado: 'status-confirm', em_atendimento: 'status-progress', concluido: 'status-done', cancelado: 'status-cancel',
};

type RangeMode = 'today' | 'week' | 'month';

function monthDays(date: Date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return Array.from({ length: last.getDate() }, (_, index) => new Date(first.getFullYear(), first.getMonth(), index + 1));
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
  const [rangeMode, setRangeMode] = useState<RangeMode>('week');
  const [cursor, setCursor] = useState(() => new Date());
  const [mode, setMode] = useState<'agenda' | 'map'>('agenda');
  const [mapRecency, setMapRecency] = useState<RecencyBucket | null>(null);
  const [rangeAppointments, setRangeAppointments] = useState<Appointment[]>([]);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [localCopies, setLocalCopies] = useState<Appointment[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [reasonFilters, setReasonFilters] = useState<string[]>([]);

  useEffect(() => {
    if (rangeMode === 'week') setCursor(weekStart);
  }, [weekStart, rangeMode]);

  const days = useMemo(() => {
    if (rangeMode === 'today') return [new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())];
    if (rangeMode === 'month') return monthDays(cursor);
    const first = startOfWeek(cursor);
    return Array.from({ length: 6 }, (_, i) => addDays(first, i));
  }, [cursor, rangeMode]);

  const title = useMemo(() => {
    if (rangeMode === 'today') return fullDate.format(days[0]);
    if (rangeMode === 'month') return monthTitle.format(cursor).replace(/^./, (letter) => letter.toUpperCase());
    return `${dayDate.format(days[0])} — ${dayDate.format(days[days.length - 1])}`;
  }, [cursor, days, rangeMode]);

  useEffect(() => { setLocalCopies([]); }, [cursor, rangeMode]);

  useEffect(() => {
    if (!days.length || !technicians.length) {
      setRangeAppointments([]);
      return;
    }
    let cancelled = false;
    async function loadRange() {
      setRangeLoading(true);
      const branches = Array.from(new Set(technicians.map((item) => item.branch).filter(Boolean)));
      let query = supabase
        .from('appointments')
        .select('id,branch,appointment_date,technician_id,client_name,equipment_serial,service_city,status,service_reason,description,reported_hourmeter,forecast_amount,billing_status')
        .gte('appointment_date', isoDate(days[0]))
        .lte('appointment_date', isoDate(days[days.length - 1]))
        .order('appointment_date');
      if (branches.length) query = query.in('branch', branches);
      const { data } = await query;
      if (!cancelled) {
        setRangeAppointments((data || []) as Appointment[]);
        setRangeLoading(false);
      }
    }
    void loadRange();
    return () => { cancelled = true; };
  }, [days.map(isoDate).join('|'), technicians.map((item) => `${item.id}:${item.branch}`).join('|')]);

  const allAppointments = useMemo(() => {
    const merged = [...appointments, ...rangeAppointments, ...localCopies];
    const byId = new Map<string, Appointment>();
    merged.forEach((item) => byId.set(item.id, item));
    return Array.from(byId.values());
  }, [appointments, rangeAppointments, localCopies]);

  const visibleAppointments = useMemo(() => reasonFilters.length
    ? allAppointments.filter((item) => reasonFilters.includes(item.service_reason || ''))
    : allAppointments, [allAppointments, reasonFilters]);
  const visibleDateSet = useMemo(() => new Set(days.map(isoDate)), [days]);
  const visibleRangeAppointments = useMemo(() => visibleAppointments.filter((item) => visibleDateSet.has(item.appointment_date)), [visibleAppointments, visibleDateSet]);
  const forecast = visibleRangeAppointments.reduce((sum, item) => sum + Number(item.forecast_amount || 0), 0);
  const dragged = draggedId ? allAppointments.find((item) => item.id === draggedId) || null : null;
  const gridStyle = { gridTemplateColumns: `180px repeat(${days.length}, minmax(150px,1fr))`, minWidth: `${Math.max(360, 180 + days.length * 150)}px` };

  function toggleReasonFilter(reason: string) {
    setReasonFilters((current) => current.includes(reason) ? current.filter((item) => item !== reason) : [...current, reason]);
  }

  function selectRange(next: RangeMode) {
    const now = new Date();
    setRangeMode(next);
    setCursor(now);
    if (next === 'week') onWeek(now);
  }

  function navigate(direction: -1 | 1) {
    if (rangeMode === 'today') {
      const next = addDays(cursor, direction);
      setCursor(next);
      return;
    }
    if (rangeMode === 'month') {
      setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1));
      return;
    }
    const next = addDays(cursor, 7 * direction);
    setCursor(next);
    onWeek(next);
  }

  async function copyAppointment(source: Appointment, targetDate: string, targetTechnicianId: string) {
    if (copying || (source.appointment_date === targetDate && source.technician_id === targetTechnicianId)) return;
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
      <div><strong>{title}</strong><span>{visibleRangeAppointments.length} atendimento{visibleRangeAppointments.length === 1 ? '' : 's'} · {money.format(forecast)}{reasonFilters.length ? ` · ${reasonFilters.length} filtro${reasonFilters.length === 1 ? '' : 's'}` : ''}</span></div>
      <div className="toolbar-actions">
        <div className="agenda-view-tabs" aria-label="Visualização da agenda">
          <button type="button" className={mode === 'agenda' ? 'active' : ''} onClick={() => setMode('agenda')}><CalendarDays size={15}/> Agenda</button>
          <button type="button" className={mode === 'map' ? 'active' : ''} onClick={() => setMode('map')}><Map size={15}/> Mapa</button>
        </div>
        <div className="agenda-range-tabs" aria-label="Período da agenda">
          <button type="button" className={rangeMode === 'today' ? 'active' : ''} onClick={() => selectRange('today')}>Hoje</button>
          <button type="button" className={rangeMode === 'week' ? 'active' : ''} onClick={() => selectRange('week')}>Semana</button>
          <button type="button" className={rangeMode === 'month' ? 'active' : ''} onClick={() => selectRange('month')}>Mês</button>
        </div>
        <button className="icon-button" aria-label="Período anterior" onClick={() => navigate(-1)}><ChevronLeft size={18} /></button>
        <button className="icon-button" aria-label="Próximo período" onClick={() => navigate(1)}><ChevronRight size={18} /></button>
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
        {(loading || rangeLoading) ? <div className="agenda-loading">Carregando agenda...</div> : technicians.length === 0 ? <div className="agenda-empty"><strong>Nenhum técnico cadastrado.</strong><span>Adicione o primeiro técnico para começar a montar a agenda.</span><button className="primary-button" onClick={onAddTechnician}><Plus size={17}/> Adicionar técnico</button></div> : technicians.map((tech) => (
          <div className="agenda-grid agenda-row" style={gridStyle} key={tech.id}>
            <div className="tech-col tech-name"><strong>{tech.name}</strong><span>{tech.branch}</span></div>
            {days.map((day) => {
              const date = isoDate(day);
              const cellKey = `${tech.id}|${date}`;
              const allCellItems = allAppointments.filter((item) => item.technician_id === tech.id && item.appointment_date === date);
              const items = visibleAppointments.filter((item) => item.technician_id === tech.id && item.appointment_date === date);
              const canDrop = Boolean(dragged && (dragged.technician_id !== tech.id || dragged.appointment_date !== date));
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
                    className={`appointment-card ${statusClass[item.status] || ''} ${draggedId === item.id ? 'copy-dragging' : ''} ${hasForecast ? 'has-revenue' : ''}`}
                    style={{ background: typeStyle.background, borderLeftColor: typeStyle.color }}
                    onDragStart={(event) => { setDraggedId(item.id); event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('text/plain', item.id); }}
                    onDragEnd={() => { setDraggedId(null); setDropTarget(null); }}
                    onClick={(e) => { e.stopPropagation(); if (!draggedId) onEdit(item); }}
                    title="Arraste para outro dia ou para outro técnico para copiar"
                  >
                    {hasForecast && <small className="appointment-card-revenue">{money.format(Number(item.forecast_amount))}</small>}
                    <strong>{item.client_name || item.service_reason || 'Atendimento'}</strong>
                    <span>{item.service_city || 'Cidade não informada'}</span>
                    <small className="appointment-card-reason">{item.service_reason || 'Motivo não informado'}{item.equipment_serial ? ` · ${item.equipment_serial}` : ''}</small>
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
        appointments={visibleRangeAppointments}
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
