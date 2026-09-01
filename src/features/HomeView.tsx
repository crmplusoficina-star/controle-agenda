import { CalendarClock, CalendarDays, ChevronRight, PhoneCall, Target, UserRound } from 'lucide-react';
import type { Appointment, Followup, Technician } from '../types';
import './home-view.css';

function localDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromIso(value: string) {
  const [, month, day] = value.split('-');
  return `${day}/${month}`;
}

function money(value: number | null | undefined) {
  if (!value) return null;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function followupValue(item: Followup) {
  const parts = Number(item.parts_value || 0);
  const services = Number(item.services_value || 0);
  const total = parts + services;
  if (total > 0) return total;
  return item.estimated_value || null;
}

function responsible(item: Followup) {
  return item.updated_by_name || item.created_by_name || 'Sem consultor';
}

export function HomeView({
  appointments,
  technicians,
  followups,
  loading,
  consultantName,
  consultantMatricula,
  onAppointment,
  onFollowup,
}: {
  appointments: Appointment[];
  technicians: Technician[];
  followups: Followup[];
  loading: boolean;
  consultantName: string;
  consultantMatricula: string;
  onAppointment: (item: Appointment) => void;
  onFollowup: (item: Followup) => void;
}) {
  const today = localDate();
  const techById = new Map(technicians.map((item) => [item.id, item]));
  const openFollowups = followups.filter((item) => item.stage !== 'encerrar');
  const mine = openFollowups.filter((item) =>
    item.updated_by_matricula === consultantMatricula || item.created_by_matricula === consultantMatricula || responsible(item) === consultantName,
  );

  const todayAppointments = appointments
    .filter((item) => item.appointment_date === today && item.status !== 'cancelado')
    .sort((a, b) => (a.client_name || '').localeCompare(b.client_name || ''));
  const nextAppointments = appointments
    .filter((item) => item.appointment_date > today && item.status !== 'cancelado')
    .sort((a, b) => a.appointment_date.localeCompare(b.appointment_date))
    .slice(0, 8);

  // A prospecção do dia usa created_at, e não updated_at. Assim editar/atualizar a mesma tratativa não aumenta a meta.
  const prospectedToday = followups.filter((item) => {
    const createdDay = item.created_at?.slice(0, 10);
    return createdDay === today && (item.created_by_matricula === consultantMatricula || item.created_by_name === consultantName);
  });
  const uniqueProspected = Array.from(new Map(prospectedToday.map((item) => [`${item.branch}|${item.client_name.toUpperCase()}`, item])).values());

  const contactToday = mine
    .filter((item) => item.next_followup_date === today)
    .sort((a, b) => a.client_name.localeCompare(b.client_name));
  const nextContacts = mine
    .filter((item) => (item.next_followup_date || '') > today)
    .sort((a, b) => (a.next_followup_date || '').localeCompare(b.next_followup_date || ''))
    .slice(0, 8);

  if (loading) return <div className="home-loading">Carregando seu dia...</div>;

  return (
    <section className="home-view">
      <div className="home-consultant-strip">
        <div className="home-consultant-avatar"><UserRound size={18} /></div>
        <div><span>Consultor</span><strong>{consultantName}</strong></div>
        <div className={`home-goal ${uniqueProspected.length >= 3 ? 'done' : ''}`}>
          <span>Meta de prospecção hoje</span>
          <strong>{uniqueProspected.length}/3</strong>
        </div>
      </div>

      <div className="home-grid">
        <HomeCard icon={<CalendarDays size={17} />} title="Agendamentos de hoje" count={todayAppointments.length} empty="Nenhum atendimento para hoje.">
          {todayAppointments.map((item) => {
            const tech = techById.get(item.technician_id);
            return <HomeItem key={item.id} title={item.client_name || 'Atendimento sem cliente'} subtitle={`${tech?.name || 'Técnico'} · ${item.service_city || item.branch}`} meta={item.service_reason || undefined} onClick={() => onAppointment(item)} />;
          })}
        </HomeCard>

        <HomeCard icon={<CalendarClock size={17} />} title="Próximos agendamentos" count={nextAppointments.length} empty="Nenhum próximo atendimento nesta agenda.">
          {nextAppointments.map((item) => {
            const tech = techById.get(item.technician_id);
            return <HomeItem key={item.id} title={item.client_name || 'Atendimento sem cliente'} subtitle={`${dateFromIso(item.appointment_date)} · ${tech?.name || 'Técnico'} · ${item.service_city || item.branch}`} meta={item.service_reason || undefined} onClick={() => onAppointment(item)} />;
          })}
        </HomeCard>

        <HomeCard icon={<Target size={17} />} title="Clientes que prospectei hoje" count={uniqueProspected.length} badge={`${uniqueProspected.length}/3`} empty="Ainda nenhum cliente prospectado hoje.">
          {uniqueProspected.slice(0, 6).map((item) => <HomeItem key={item.id} title={item.client_name} subtitle={item.branch} meta={item.notes || undefined} onClick={() => onFollowup(item)} />)}
        </HomeCard>

        <HomeCard icon={<PhoneCall size={17} />} title="Clientes para entrar em contato hoje" count={contactToday.length} empty="Nenhum contato programado para hoje.">
          {contactToday.map((item) => <HomeItem key={item.id} title={item.client_name} subtitle={item.notes || 'Entrar em contato'} meta={money(followupValue(item)) || undefined} onClick={() => onFollowup(item)} />)}
        </HomeCard>

        <HomeCard icon={<PhoneCall size={17} />} title="Próximos clientes para entrar em contato" count={nextContacts.length} wide empty="Nenhum próximo contato programado.">
          {nextContacts.map((item) => <HomeItem key={item.id} title={item.client_name} subtitle={`${dateFromIso(item.next_followup_date!)} · ${item.notes || 'Entrar em contato'}`} meta={money(followupValue(item)) || undefined} onClick={() => onFollowup(item)} />)}
        </HomeCard>
      </div>
    </section>
  );
}

function HomeCard({ icon, title, count, badge, empty, wide = false, children }: { icon: React.ReactNode; title: string; count: number; badge?: string; empty: string; wide?: boolean; children: React.ReactNode }) {
  return <article className={`home-card ${wide ? 'wide' : ''}`}>
    <header><div className="home-card-title"><span>{icon}</span><strong>{title}</strong></div>{badge ? <b className="home-card-badge">{badge}</b> : <em>{count}</em>}</header>
    <div className="home-card-list">{count ? children : <div className="home-empty">{empty}</div>}</div>
  </article>;
}

function HomeItem({ title, subtitle, meta, onClick }: { title: string; subtitle: string; meta?: string; onClick: () => void }) {
  return <button type="button" className="home-item" onClick={onClick}>
    <div><strong>{title}</strong><span>{subtitle}</span>{meta && <small>{meta}</small>}</div>
    <ChevronRight size={16} />
  </button>;
}
