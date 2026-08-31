import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { Appointment, Technician } from '../types';
import { addDays, isoDate } from '../lib/date';
import { supabase } from '../lib/supabase';
import { APPOINTMENT_TYPE_LEGEND, appointmentTypeStyle } from './appointmentTypes';
import './agenda-colors.css';

const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
const dayDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const statusClass: Record<string, string> = {
  planejado: 'status-plan', confirmado: 'status-confirm', em_atendimento: 'status-progress', concluido: 'status-done', cancelado: 'status-cancel',
};

export function AgendaView({ weekStart, onWeek, technicians, appointments, loading, onNew, onEdit, onAddTechnician }: {
  weekStart: Date;
  onWeek: (date: Date) => void;
  technicians: Technician[];
  appointments: Appointment[];
  loading: boolean;
  onNew: (date: string, technicianId: string) => void;
  onEdit: (appointment: Appointment) => void;
  onAddTechnician: () => void;
}) {
  const days = Array.from({ length: 6 }, (_, i) => addDays(weekStart, i));
  const weekEnd = days[5];
  const title = `${dayDate.format(weekStart)} — ${dayDate.format(weekEnd)}`;
  const [localCopies, setLocalCopies] = useState<Appointment[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);

  useEffect(() => { setLocalCopies([]); }, [weekStart]);

  const allAppointments = useMemo(() => {
    const known = new Set(appointments.map((item) => item.id));
    return [...appointments, ...localCopies.filter((item) => !known.has(item.id))];
  }, [appointments, localCopies]);

  const forecast = allAppointments.reduce((sum, item) => sum + Number(item.forecast_amount || 0), 0);
  const dragged = draggedId ? allAppointments.find((item) => item.id === draggedId) || null : null;

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
      <div><strong>{title}</strong><span>{allAppointments.length} atendimento{allAppointments.length === 1 ? '' : 's'} · {money.format(forecast)}</span></div>
      <div className="toolbar-actions">
        <button className="subtle-button" onClick={() => onWeek(new Date())}>Hoje</button>
        <button className="icon-button" onClick={() => onWeek(addDays(weekStart, -7))}><ChevronLeft size={18} /></button>
        <button className="icon-button" onClick={() => onWeek(addDays(weekStart, 7))}><ChevronRight size={18} /></button>
        <button className="primary-button" onClick={onAddTechnician}><Plus size={17} /> Técnico</button>
      </div>
    </div>

    <div className="agenda-type-legend" aria-label="Legenda dos tipos de atendimento">
      {APPOINTMENT_TYPE_LEGEND.map((item) => <span className="agenda-type-legend-item" key={item.label}><i className="agenda-type-swatch" style={{ background: item.color }} />{item.label}</span>)}
    </div>

    <div className="agenda-shell agenda-week-fit">
      <div className="agenda-grid agenda-head">
        <div className="tech-col">Técnico</div>
        {days.map((day) => <div key={isoDate(day)} className="day-head"><span>{dayName.format(day).replace('.', '')}</span><strong>{dayDate.format(day)}</strong></div>)}
      </div>
      {loading ? <div className="agenda-loading">Carregando agenda...</div> : technicians.length === 0 ? <div className="agenda-empty"><strong>Nenhum técnico cadastrado.</strong><span>Adicione o primeiro técnico para começar a montar a agenda.</span><button className="primary-button" onClick={onAddTechnician}><Plus size={17}/> Adicionar técnico</button></div> : technicians.map((tech) => (
        <div className="agenda-grid agenda-row" key={tech.id}>
          <div className="tech-col tech-name"><strong>{tech.name}</strong><span>{tech.branch}</span></div>
          {days.map((day) => {
            const date = isoDate(day);
            const cellKey = `${tech.id}|${date}`;
            const items = allAppointments.filter((item) => item.technician_id === tech.id && item.appointment_date === date);
            const canDrop = Boolean(dragged && dragged.technician_id === tech.id && dragged.appointment_date !== date);
            return <div
              className={`day-cell ${dropTarget === cellKey && canDrop ? 'copy-drop-target' : ''}`}
              key={date}
              onClick={() => items.length === 0 && !draggedId && onNew(date, tech.id)}
              onDragOver={(event) => { if (!canDrop) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropTarget(cellKey); }}
              onDragLeave={() => dropTarget === cellKey && setDropTarget(null)}
              onDrop={(event) => { event.preventDefault(); if (dragged && canDrop) void copyAppointment(dragged, date, tech.id); }}
            >
              {items.length === 0 ? <button className="cell-add" onClick={(e) => { e.stopPropagation(); onNew(date, tech.id); }}><Plus size={16}/></button> : items.map((item) => {
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
  </div>;
}
