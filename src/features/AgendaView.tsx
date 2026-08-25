import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { Appointment, Technician } from '../types';
import { addDays, isoDate } from '../lib/date';

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
  const forecast = appointments.reduce((sum, item) => sum + Number(item.forecast_amount || 0), 0);
  const shellRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, startX: 0, scrollLeft: 0 });
  const [dragging, setDragging] = useState(false);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a')) return;
    const shell = shellRef.current;
    if (!shell || shell.scrollWidth <= shell.clientWidth) return;
    dragRef.current = { active: true, startX: event.clientX, scrollLeft: shell.scrollLeft };
    setDragging(true);
    shell.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const shell = shellRef.current;
    if (!shell || !dragRef.current.active) return;
    shell.scrollLeft = dragRef.current.scrollLeft - (event.clientX - dragRef.current.startX);
  }

  function stopDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const shell = shellRef.current;
    dragRef.current.active = false;
    setDragging(false);
    if (shell?.hasPointerCapture(event.pointerId)) shell.releasePointerCapture(event.pointerId);
  }

  return <div className="agenda-view">
    <div className="agenda-toolbar">
      <div><strong>{title}</strong><span>{appointments.length} atendimento{appointments.length === 1 ? '' : 's'} · {money.format(forecast)}</span></div>
      <div className="toolbar-actions">
        <button className="subtle-button" onClick={() => onWeek(new Date())}>Hoje</button>
        <button className="icon-button" onClick={() => onWeek(addDays(weekStart, -7))}><ChevronLeft size={18} /></button>
        <button className="icon-button" onClick={() => onWeek(addDays(weekStart, 7))}><ChevronRight size={18} /></button>
        <button className="primary-button" onClick={onAddTechnician}><Plus size={17} /> Técnico</button>
      </div>
    </div>
    <div
      className={`agenda-shell agenda-drag-scroll ${dragging ? 'dragging' : ''}`}
      ref={shellRef}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      title="Arraste para os lados para navegar pela agenda"
    >
      <div className="agenda-grid agenda-head">
        <div className="tech-col">Técnico</div>
        {days.map((day) => <div key={isoDate(day)} className="day-head"><span>{dayName.format(day).replace('.', '')}</span><strong>{dayDate.format(day)}</strong></div>)}
      </div>
      {loading ? <div className="agenda-loading">Carregando agenda...</div> : technicians.length === 0 ? <div className="agenda-empty"><strong>Nenhum técnico cadastrado.</strong><span>Adicione o primeiro técnico para começar a montar a agenda.</span><button className="primary-button" onClick={onAddTechnician}><Plus size={17}/> Adicionar técnico</button></div> : technicians.map((tech) => (
        <div className="agenda-grid agenda-row" key={tech.id}>
          <div className="tech-col tech-name"><strong>{tech.name}</strong><span>{tech.branch}</span></div>
          {days.map((day) => {
            const date = isoDate(day);
            const items = appointments.filter((item) => item.technician_id === tech.id && item.appointment_date === date);
            return <div className="day-cell" key={date} onClick={() => items.length === 0 && onNew(date, tech.id)}>
              {items.length === 0 ? <button className="cell-add" onClick={(e) => { e.stopPropagation(); onNew(date, tech.id); }}><Plus size={16}/></button> : items.map((item) => (
                <button key={item.id} className={`appointment-card ${statusClass[item.status] || ''}`} onClick={(e) => { e.stopPropagation(); onEdit(item); }}>
                  <strong>{item.client_name || item.service_reason || 'Atendimento'}</strong>
                  <span>{item.service_city || 'Cidade não informada'}</span>
                  <small>{item.service_reason || 'Motivo não informado'}{item.equipment_serial ? ` · ${item.equipment_serial}` : ''}</small>
                </button>
              ))}
            </div>;
          })}
        </div>
      ))}
    </div>
  </div>;
}
