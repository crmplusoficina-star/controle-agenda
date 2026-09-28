import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { CalendarDays, Expand, MapPinned, Navigation, RadioTower, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { addDays, isoDate, startOfWeek } from '../lib/date';
import { useSession } from '../session';
import type { Appointment, AppointmentRouteMetric, Technician } from '../types';
import 'leaflet/dist/leaflet.css';
import './presentation.css';

const ROTATION_MS = 10000;
const REFRESH_MS = 30000;
const TECHNICIANS_PER_PAGE = 3;
const techColors = ['#2563eb', '#0891b2', '#16a34a', '#d97706', '#9333ea', '#e11d48', '#4f46e5', '#0f766e'];

type PresentationPoint = {
  id: string;
  kind: 'branch' | 'appointment' | 'client';
  lat: number;
  lng: number;
  client_name?: string | null;
  service_city?: string | null;
  appointment_date?: string;
  technician_id?: string;
  technician_name?: string | null;
};

type MapResponse = {
  points?: PresentationPoint[];
};

type PresentationData = {
  technicians: Technician[];
  appointments: Appointment[];
  routeMetrics: Record<string, AppointmentRouteMetric>;
  points: PresentationPoint[];
};

const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
const dayDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const weekLabel = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function fold(value?: string | null) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function techColor(technicianId: string) {
  let hash = 0;
  for (let index = 0; index < technicianId.length; index += 1) hash = ((hash << 5) - hash + technicianId.charCodeAt(index)) | 0;
  return techColors[Math.abs(hash) % techColors.length];
}

function markerIcon(color: string, label: string, current: boolean) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${current ? 46 : 40}px;height:${current ? 46 : 40}px;border-radius:999px;background:${current ? color : '#fff'};color:${current ? '#fff' : color};border:4px solid ${color};box-shadow:0 8px 24px rgba(15,23,42,.28);display:grid;place-items:center;font:800 13px/1 Inter,Arial;box-sizing:border-box;position:relative">${label}<span style="position:absolute;inset:-7px;border:2px solid ${color};border-radius:999px;opacity:${current ? '.28' : '0'}"></span></div>`,
    iconSize: current ? [46, 46] : [40, 40],
    iconAnchor: current ? [23, 23] : [20, 20],
  });
}

function FitPresentationMap({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView(points[0], 10);
      return;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [46, 46], maxZoom: 11 });
  }, [map, points]);
  return null;
}

function appointmentPoint(points: PresentationPoint[], appointmentId: string) {
  return points.find((point) => point.kind === 'appointment' && point.id.replace('appointment:', '') === appointmentId);
}

function currentAndNext(appointments: Appointment[], technicianId: string, today: string) {
  const items = appointments
    .filter((item) => item.technician_id === technicianId && item.status !== 'cancelado')
    .slice()
    .sort((a, b) => a.appointment_date.localeCompare(b.appointment_date) || a.id.localeCompare(b.id));

  const todayItems = items.filter((item) => item.appointment_date === today);
  const current = todayItems.find((item) => item.status === 'em_atendimento')
    || todayItems.find((item) => item.status === 'confirmado')
    || todayItems.find((item) => item.status === 'planejado')
    || todayItems[todayItems.length - 1]
    || null;

  if (current) {
    const index = items.findIndex((item) => item.id === current.id);
    return { current, next: items.slice(index + 1).find((item) => item.appointment_date >= today) || null };
  }

  return { current: null, next: items.find((item) => item.appointment_date > today) || null };
}

export function PresentationView() {
  const { branches } = useSession();
  const [now, setNow] = useState(() => new Date());
  const [activeIndex, setActiveIndex] = useState(0);
  const [eligibleBranches, setEligibleBranches] = useState<string[] | null>(null);
  const [displayedBranch, setDisplayedBranch] = useState('');
  const [technicianPage, setTechnicianPage] = useState(0);
  const [data, setData] = useState<PresentationData>({ technicians: [], appointments: [], routeMetrics: {}, points: [] });
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState('');

  const branchNames = useMemo(() => branches.map((item) => item.name).filter(Boolean), [branches]);
  const rotationBranches = eligibleBranches ?? [];
  const activeBranch = rotationBranches[activeIndex] || rotationBranches[0] || '';
  const currentWeekStart = useMemo(() => startOfWeek(now), [now]);
  const days = useMemo(() => Array.from({ length: 6 }, (_, index) => addDays(currentWeekStart, index)), [currentWeekStart]);
  const today = isoDate(now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadEligibleBranches() {
      if (!branchNames.length) return;
      const start = isoDate(currentWeekStart);
      const end = isoDate(addDays(currentWeekStart, 5));
      const { data: rows, error: rowsError } = await supabase
        .from('appointments')
        .select('branch,status')
        .in('branch', branchNames)
        .gte('appointment_date', start)
        .lte('appointment_date', end);
      if (cancelled || rowsError) return;
      const scheduled = new Set((rows || []).filter((item: any) => item.status !== 'cancelado').map((item: any) => String(item.branch || '')));
      const next = branchNames.filter((name) => scheduled.has(name));
      setEligibleBranches(next);
      setActiveIndex((current) => next.length ? Math.min(current, next.length - 1) : 0);
    }
    void loadEligibleBranches();
    return () => { cancelled = true; };
  }, [branchNames, currentWeekStart]);

  const technicianPageCount = Math.max(1, Math.ceil(data.technicians.length / TECHNICIANS_PER_PAGE));

  useEffect(() => {
    if (!rotationBranches.length || !displayedBranch) return;
    const timer = window.setInterval(() => {
      if (technicianPage < technicianPageCount - 1) {
        setTechnicianPage((current) => current + 1);
        return;
      }
      setTechnicianPage(0);
      setActiveIndex((current) => (current + 1) % rotationBranches.length);
    }, ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [displayedBranch, rotationBranches.length, technicianPage, technicianPageCount]);

  useEffect(() => {
    if (activeIndex < rotationBranches.length) return;
    setActiveIndex(0);
  }, [activeIndex, rotationBranches.length]);

  const loadBranch = useCallback(async () => {
    if (!activeBranch) return;
    setLoading(true);
    setError('');

    const start = isoDate(currentWeekStart);
    const end = isoDate(addDays(currentWeekStart, 5));

    const [techniciansResponse, appointmentsResponse] = await Promise.all([
      supabase.from('technicians').select('id,branch,name,active').eq('active', true).eq('branch', activeBranch).order('name'),
      supabase
        .from('appointments')
        .select('id,branch,appointment_date,technician_id,client_name,equipment_serial,service_city,status,service_reason,description,reported_hourmeter,forecast_amount,billing_status,created_at')
        .eq('branch', activeBranch)
        .gte('appointment_date', start)
        .lte('appointment_date', end)
        .order('appointment_date'),
    ]);

    if (techniciansResponse.error || appointmentsResponse.error) {
      setError('Não foi possível atualizar a apresentação agora.');
      setLoading(false);
      return;
    }

    const appointments = ((appointmentsResponse.data || []) as Appointment[]).filter((item) => item.status !== 'cancelado');
    const scheduledTechnicianIds = new Set(appointments.map((item) => item.technician_id));
    const technicians = ((techniciansResponse.data || []) as Technician[]).filter((technician) => scheduledTechnicianIds.has(technician.id));
    const appointmentIds = appointments.map((item) => item.id);

    const routeMetrics: Record<string, AppointmentRouteMetric> = {};
    if (appointmentIds.length) {
      const { data: metricRows } = await supabase
        .from('agenda_route_metrics')
        .select('appointment_id,technician_id,appointment_date,week_start,origin_kind,origin_appointment_id,origin_label,destination_label,destination_city,destination_state,distance_km,duration_min,status,provider,segment_key,calculated_at')
        .in('appointment_id', appointmentIds);
      for (const metric of (metricRows || []) as AppointmentRouteMetric[]) routeMetrics[metric.appointment_id] = metric;
    }

    const clientNames = Array.from(new Set(appointments.map((item) => item.client_name).filter((item): item is string => Boolean(item))));
    let clientRows: { client_key: string; client_name: string; branch: string; city: string | null; last_service_at: string | null }[] = [];
    if (clientNames.length) {
      const { data: clients } = await supabase
        .from('g4_client_summary')
        .select('client_key,client_name,branch,city,last_service_at')
        .eq('branch', activeBranch)
        .in('client_name', clientNames)
        .limit(1000);
      clientRows = (clients || []) as typeof clientRows;
    }

    const payloadAppointments = appointments.map((item) => ({
      id: item.id,
      branch: item.branch,
      appointment_date: item.appointment_date,
      technician_id: item.technician_id,
      technician_name: technicians.find((technician) => technician.id === item.technician_id)?.name || null,
      client_name: item.client_name,
      equipment_serial: item.equipment_serial,
      service_city: item.service_city,
      service_reason: item.service_reason,
      description: item.description,
    }));

    let points: PresentationPoint[] = [];
    const mapResult = await supabase.functions.invoke('retention-map-context', {
      body: { clients: clientRows, appointments: payloadAppointments, technician_id: null },
    });
    if (!mapResult.error) points = ((mapResult.data || {}) as MapResponse).points || [];

    setData({ technicians, appointments, routeMetrics, points });
    setTechnicianPage(0);
    setDisplayedBranch(activeBranch);
    setLastUpdated(new Date());
    setLoading(false);
  }, [activeBranch, currentWeekStart]);

  useEffect(() => {
    void loadBranch();
    const refresh = window.setInterval(() => { void loadBranch(); }, REFRESH_MS);

    const channel = supabase
      .channel(`presentation-${fold(activeBranch)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, () => { void loadBranch(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'technicians' }, () => { void loadBranch(); })
      .subscribe();

    return () => {
      window.clearInterval(refresh);
      void supabase.removeChannel(channel);
    };
  }, [activeBranch, loadBranch]);

  const visibleTechnicians = useMemo(() => {
    const start = technicianPage * TECHNICIANS_PER_PAGE;
    return data.technicians.slice(start, start + TECHNICIANS_PER_PAGE);
  }, [data.technicians, technicianPage]);

  const visibleTechnicianIds = useMemo(() => new Set(visibleTechnicians.map((technician) => technician.id)), [visibleTechnicians]);
  const visibleAppointments = useMemo(() => data.appointments.filter((item) => visibleTechnicianIds.has(item.technician_id)), [data.appointments, visibleTechnicianIds]);

  const techStates = useMemo(() => visibleTechnicians.map((technician) => {
    const state = currentAndNext(visibleAppointments, technician.id, today);
    const currentPoint = state.current ? appointmentPoint(data.points, state.current.id) : undefined;
    const nextPoint = state.next ? appointmentPoint(data.points, state.next.id) : undefined;
    return { technician, ...state, currentPoint, nextPoint };
  }), [data.points, today, visibleAppointments, visibleTechnicians]);

  const mapCoordinates = useMemo(() => techStates.flatMap((item) => {
    const coordinates: [number, number][] = [];
    if (item.currentPoint) coordinates.push([item.currentPoint.lat, item.currentPoint.lng]);
    if (item.nextPoint) coordinates.push([item.nextPoint.lat, item.nextPoint.lng]);
    return coordinates;
  }), [techStates]);

  const weekEnd = days[days.length - 1];
  const displayedIndex = rotationBranches.indexOf(displayedBranch);
  const branchPosition = displayedIndex >= 0 ? displayedIndex + 1 : (rotationBranches.length ? activeIndex + 1 : 0);
  const switchingBranch = Boolean(displayedBranch && activeBranch && displayedBranch !== activeBranch);

  function requestFullscreen() {
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.();
    else void document.exitFullscreen?.();
  }

  return <div className="presentation-shell">
    <header className="presentation-header">
      <div className="presentation-brand">
        <img src="/agenda-brand.svg?v=20260928-1" alt="Agenda" />
        <div>
          <span>Agenda técnica · modo recepção</span>
          <h1>{displayedBranch || activeBranch || 'Agenda'}{technicianPageCount > 1 ? <small className="presentation-title-page"> · {technicianPage + 1}/{technicianPageCount}</small> : null}</h1>
        </div>
      </div>
      <div className="presentation-header-right">
        <div className="presentation-live"><RadioTower size={15}/><span>Atualização automática</span></div>
        <div className="presentation-week"><CalendarDays size={16}/><strong>{weekLabel.format(currentWeekStart)} — {weekLabel.format(weekEnd)}</strong></div>
        <button className="presentation-fullscreen" type="button" onClick={requestFullscreen} aria-label="Tela cheia"><Expand size={17}/></button>
      </div>
    </header>

    <main className={`presentation-content ${switchingBranch ? 'is-switching' : ''}`}>
      <section className="presentation-agenda-panel">
        <div className="presentation-panel-head">
          <div><span>Agenda da semana</span><strong>{technicianPageCount > 1 ? `${visibleTechnicians.length} de ${data.technicians.length} técnicos` : `${data.technicians.length} técnico${data.technicians.length === 1 ? '' : 's'}`}</strong></div>
          {loading && <RefreshCw className="presentation-spin" size={18}/>}
        </div>

        <div className="presentation-agenda-grid" style={{ gridTemplateColumns: 'minmax(150px, .95fr) repeat(6, minmax(115px, 1fr))' }}>
          <div className="presentation-grid-corner">Técnico</div>
          {days.map((day) => {
            const dayIso = isoDate(day);
            return <div className={dayIso === today ? 'presentation-day-head is-today' : 'presentation-day-head'} key={dayIso}>
              <span>{dayName.format(day).replace('.', '')}</span>
              <strong>{dayDate.format(day)}</strong>
            </div>;
          })}

          {visibleTechnicians.map((technician) => {
            const color = techColor(technician.id);
            return [
              <div className="presentation-tech" key={`${technician.id}-name`}>
                <i style={{ background: color }}/>
                <div><strong>{technician.name}</strong><span>{displayedBranch || activeBranch}</span></div>
              </div>,
              ...days.map((day) => {
                const dayIso = isoDate(day);
                const items = visibleAppointments.filter((item) => item.technician_id === technician.id && item.appointment_date === dayIso && item.status !== 'cancelado');
                return <div className={dayIso === today ? 'presentation-day-cell is-today' : 'presentation-day-cell'} key={`${technician.id}-${dayIso}`}>
                  {items.length === 0 ? <span className="presentation-empty">—</span> : items.slice(0, 2).map((item) => <div className="presentation-appointment" style={{ borderLeftColor: color }} key={item.id}>
                    <strong>{item.client_name || item.service_reason || 'Atendimento'}</strong>
                    <span>{item.service_city || 'Cidade não informada'}</span>
                  </div>)}
                  {items.length > 2 && <small className="presentation-more">+{items.length - 2} atendimento{items.length - 2 === 1 ? '' : 's'}</small>}
                </div>;
              }),
            ];
          })}
        </div>

        {!loading && data.technicians.length === 0 && <div className="presentation-no-data">Nenhum técnico ativo nesta filial.</div>}
      </section>

      <section className="presentation-map-panel">
        <div className="presentation-panel-head">
          <div><span>Operação de hoje</span><strong>Local atual e próximo atendimento</strong></div>
          <div className="presentation-map-legend"><span><i className="current"/>HOJE</span><span><i className="next"/>PRÓXIMO</span></div>
        </div>

        <div className="presentation-map-wrap">
          <MapContainer center={[-4.2, -49.3]} zoom={6} zoomControl={false} attributionControl className="presentation-map">
            <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <FitPresentationMap points={mapCoordinates} />
            {techStates.map((item) => {
              const color = techColor(item.technician.id);
              const currentPosition: [number, number] | null = item.currentPoint ? [item.currentPoint.lat, item.currentPoint.lng] : null;
              const nextPosition: [number, number] | null = item.nextPoint ? [item.nextPoint.lat, item.nextPoint.lng] : null;
              return <Fragment key={item.technician.id}>
                {currentPosition && nextPosition && <Polyline positions={[currentPosition, nextPosition]} pathOptions={{ color, weight: 4, opacity: .72, dashArray: '10 9' }} />}
                {currentPosition && <Marker position={currentPosition} icon={markerIcon(color, 'H', true)}>
                  <Tooltip direction="top" offset={[0, -24]} opacity={1}>
                    <div className="presentation-map-tooltip"><strong>{item.technician.name}</strong><span>Hoje · {item.current?.client_name || 'Atendimento'}</span><small>{item.current?.service_city || ''}</small></div>
                  </Tooltip>
                </Marker>}
                {nextPosition && <Marker position={nextPosition} icon={markerIcon(color, 'P', false)}>
                  <Tooltip direction="top" offset={[0, -20]} opacity={1}>
                    <div className="presentation-map-tooltip"><strong>{item.technician.name}</strong><span>Próximo · {item.next?.client_name || 'Atendimento'}</span><small>{item.next?.service_city || ''}</small></div>
                  </Tooltip>
                </Marker>}
              </Fragment>;
            })}
          </MapContainer>

          <div className="presentation-status-stack">
            {techStates.map((item) => {
              const color = techColor(item.technician.id);
              const metric = item.next ? data.routeMetrics[item.next.id] : undefined;
              return <div className="presentation-status-card" key={item.technician.id}>
                <i style={{ background: color }}/>
                <div className="presentation-status-name"><strong>{item.technician.name}</strong><span>{item.current ? (item.current.service_city || item.current.client_name || 'Em atendimento') : 'Sem atendimento hoje'}</span></div>
                <Navigation size={14}/>
                <div className="presentation-status-next"><span>Próximo</span><strong>{item.next ? (item.next.service_city || item.next.client_name || 'Atendimento') : 'Sem próximo atendimento'}</strong>{metric?.status === 'ready' && metric.distance_km != null && <small>{metric.distance_km.toLocaleString('pt-BR')} km</small>}</div>
              </div>;
            })}
          </div>

          {!mapCoordinates.length && !loading && <div className="presentation-map-empty"><MapPinned size={28}/><strong>Sem localização para exibir</strong><span>A agenda continua atualizada normalmente.</span></div>}
        </div>
      </section>
          {switchingBranch && <div className="presentation-transition"><div className="presentation-transition-card"><RefreshCw className="presentation-spin" size={22}/><span>Próxima filial</span><strong>{activeBranch}</strong></div></div>}
    </main>

    <footer className="presentation-footer">
      <div><span>Filial {branchPosition} de {rotationBranches.length || 0}{technicianPageCount > 1 ? ` · tela ${technicianPage + 1}/${technicianPageCount}` : ''}</span><strong>{displayedBranch || activeBranch}</strong></div>
      <div className="presentation-update-time">{error || (lastUpdated ? `Atualizado às ${timeFmt.format(lastUpdated)}` : 'Carregando dados...')}</div>
      <div className="presentation-progress-track"><div key={`${displayedBranch || activeBranch}-${technicianPage}`} className="presentation-progress-bar"/></div>
    </footer>
  </div>;
}
