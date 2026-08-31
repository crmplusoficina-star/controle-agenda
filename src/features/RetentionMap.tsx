import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { CalendarPlus, Loader2, MapPinned, RefreshCw, Route } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { CheckboxMultiSelect } from '../components/CheckboxMultiSelect';
import type { Appointment, ClientSummary, Technician } from '../types';
import { recencyColor, retentionRecency } from './retentionRecency';
import type { RecencyBucket } from './retentionRecency';
import 'leaflet/dist/leaflet.css';
import './retention-map.css';

const retentionKey = (clientName: string, branchName: string) => `${clientName.trim().toUpperCase()}|${branchName.trim().toUpperCase()}`;
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const shortDayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });

const TECHNICAL_BASES = [
  { name: 'Tracbel BALSAS', branch: 'BALSAS', lat: -7.5325, lng: -46.0356 },
  { name: 'Tracbel IMPERATRIZ', branch: 'IMPERATRIZ', lat: -5.5264, lng: -47.4917 },
  { name: 'Tracbel ITAITINGA', branch: 'ITAITINGA', lat: -3.9694, lng: -38.5288 },
  { name: 'Tracbel SAO LUIS', branch: 'SAO LUIS', lat: -2.5307, lng: -44.3068 },
  { name: 'Tracbel TERESINA', branch: 'TERESINA', lat: -5.0892, lng: -42.8019 },
  { name: 'Tracbel MARITUBA', branch: 'MARITUBA', lat: -1.3550, lng: -48.3420 },
  { name: 'Tracbel MARABA', branch: 'MARABA', lat: -5.3686, lng: -49.1178 },
  { name: 'Tracbel MIRITITUBA', branch: 'MIRITITUBA', lat: -4.2760, lng: -55.9830 },
  { name: 'Tracbel MANAUS', branch: 'MANAUS', lat: -3.1190, lng: -60.0217 },
] as const;

export type MapPoint = {
  id: string;
  kind: 'branch' | 'appointment' | 'client';
  lat: number;
  lng: number;
  precision?: string;
  branch?: string;
  name?: string;
  client_key?: string;
  client_name?: string | null;
  city?: string | null;
  state?: string | null;
  location_source?: string | null;
  location_label?: string | null;
  last_service_at?: string | null;
  appointment_date?: string;
  technician_id?: string;
  technician_name?: string | null;
  equipment_serial?: string | null;
  service_city?: string | null;
  service_reason?: string | null;
  description?: string | null;
  near_route?: boolean;
  route_distance_km?: number;
};

type MapResponse = {
  points: MapPoint[];
  route: {
    technician_id: string;
    approximate: boolean;
    origin_label: string;
    geometry: [number, number][];
    nearby_clients?: number;
    radius_km?: number;
  } | null;
  unresolved: number;
  geocoded_now: number;
  requested_clients?: number;
  located_clients?: number;
};

function localIso(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function relativeDayLabel(dateValue: string) {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dateValue === localIso(today)) return 'HOJE';
  if (dateValue === localIso(tomorrow)) return 'AMANHÃ';
  const date = new Date(`${dateValue}T12:00:00`);
  return shortDayFmt.format(date).replace('.', '').toUpperCase();
}

function fold(value?: string | null) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function isTravelAppointment(point: Pick<MapPoint, 'service_reason' | 'description' | 'client_name'>) {
  const text = fold(`${point.service_reason || ''} ${point.description || ''} ${point.client_name || ''}`);
  return text.includes('deslocamento') || text.includes('desloc') || text.includes('viagem');
}

function hashText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash);
}

function visiblePosition(point: MapPoint): [number, number] {
  if (point.precision !== 'city') return [point.lat, point.lng];
  const hash = hashText(point.client_key || point.id);
  const angle = ((hash % 360) * Math.PI) / 180;
  const ring = 1 + (Math.floor(hash / 360) % 4);
  const distance = 0.0035 * ring;
  return [point.lat + Math.sin(angle) * distance, point.lng + Math.cos(angle) * distance];
}

function agendaVisiblePosition(points: MapPoint[], index: number): [number, number] {
  const point = points[index];
  const samePlace = points.filter((item) => Math.abs(item.lat - point.lat) < 0.00015 && Math.abs(item.lng - point.lng) < 0.00015);
  if (samePlace.length <= 1) return [point.lat, point.lng];
  const occurrence = points.slice(0, index + 1).filter((item) => Math.abs(item.lat - point.lat) < 0.00015 && Math.abs(item.lng - point.lng) < 0.00015).length - 1;
  const angle = (Math.PI * 2 * occurrence) / samePlace.length;
  const radius = 0.0055;
  return [point.lat + Math.sin(angle) * radius, point.lng + Math.cos(angle) * radius];
}

function baseIcon() {
  return L.divIcon({
    className: '',
    html: '<div style="width:34px;height:34px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:18px;background:#fff;border:2px solid #0f172a;box-shadow:0 4px 10px rgba(15,23,42,.22);box-sizing:border-box">🏠</div>',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -18],
  });
}

function agendaIcon(sequence: number, travel = false) {
  const emoji = travel ? '🚗' : '🧑‍🔧';
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:40px;height:40px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:19px;background:${travel ? '#fef3c7' : '#dbeafe'};border:3px solid ${travel ? '#d97706' : '#1d4ed8'};box-shadow:0 5px 14px rgba(15,23,42,.28);box-sizing:border-box">${emoji}<b style="position:absolute;right:-6px;top:-7px;min-width:18px;height:18px;padding:0 4px;border-radius:999px;background:#0f172a;color:white;border:2px solid white;font:800 10px/14px Arial;text-align:center;box-sizing:border-box">${sequence}</b></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -21],
  });
}

const branchMarkerIcon = baseIcon();

function FitMap({ points, route }: { points: MapPoint[]; route: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    const coordinates: [number, number][] = route.length
      ? route
      : points.map((point) => point.kind === 'client' ? visiblePosition(point) : [point.lat, point.lng]);
    if (!coordinates.length) return;
    if (coordinates.length === 1) {
      map.setView(coordinates[0], 11);
      return;
    }
    map.fitBounds(L.latLngBounds(coordinates), { padding: [35, 35], maxZoom: 12 });
  }, [map, points, route]);
  return null;
}

export function RetentionMap({ clients, serialsByClient, appointments, technicians, weekLabel, recencyFilter, onRecencyFilter, onOpen, onFollowup, onSchedule }: {
  clients: ClientSummary[];
  serialsByClient: Record<string, string[]>;
  appointments: Appointment[];
  technicians: Technician[];
  weekLabel: string;
  recencyFilter: RecencyBucket | null;
  onRecencyFilter: (bucket: RecencyBucket | null) => void;
  onOpen: (client: ClientSummary) => void;
  onFollowup: (client: ClientSummary) => void;
  onSchedule: (client: ClientSummary, serial: string, technicianId: string) => void;
}) {
  const scheduledTechnicians = useMemo(() => {
    const ids = new Set(appointments.map((item) => item.technician_id));
    return technicians.filter((technician) => ids.has(technician.id));
  }, [appointments, technicians]);

  const [technicianIds, setTechnicianIds] = useState<string[]>([]);
  const [data, setData] = useState<MapResponse>({ points: [], route: null, unresolved: 0, geocoded_now: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const available = new Set(scheduledTechnicians.map((technician) => technician.id));
    setTechnicianIds((current) => current.filter((id) => available.has(id)));
  }, [scheduledTechnicians]);

  const routeTechnicianId = technicianIds.length === 1 ? technicianIds[0] : '';
  const clientByKey = useMemo(() => new Map(clients.map((client) => [client.client_key, client])), [clients]);

  const selectedAgenda = useMemo(() => appointments
    .filter((item) => !routeTechnicianId || item.technician_id === routeTechnicianId)
    .slice()
    .sort((a, b) => a.appointment_date.localeCompare(b.appointment_date) || a.id.localeCompare(b.id)), [appointments, routeTechnicianId]);

  const sequenceByAppointment = useMemo(() => {
    const result = new Map<string, number>();
    selectedAgenda.forEach((item, index) => result.set(item.id, index + 1));
    return result;
  }, [selectedAgenda]);

  const loadMap = useCallback(async () => {
    setLoading(true);
    setError('');
    const payloadClients = clients.map((client) => ({
      client_key: client.client_key,
      client_name: client.client_name,
      branch: client.branch,
      city: client.city,
      last_service_at: client.last_service_at,
    }));
    const visibleAppointments = technicianIds.length ? appointments.filter((item) => technicianIds.includes(item.technician_id)) : appointments;
    const payloadAppointments = visibleAppointments.map((item) => ({
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

    const { data: response, error: invokeError } = await supabase.functions.invoke('retention-map-context', {
      body: { clients: payloadClients, appointments: payloadAppointments, technician_id: routeTechnicianId || null },
    });

    if (invokeError) setError('A localização avançada não respondeu; usando a agenda e as cidades já disponíveis no mapa.');
    else setData((response || { points: [], route: null, unresolved: 0, geocoded_now: 0 }) as MapResponse);
    setLoading(false);
  }, [appointments, clients, routeTechnicianId, technicianIds, technicians]);

  useEffect(() => { void loadMap(); }, [loadMap]);

  const routeLabel = routeTechnicianId
    ? scheduledTechnicians.find((technician) => technician.id === routeTechnicianId)?.name || 'Técnico selecionado'
    : '';
  const clientPoints = useMemo(() => data.points.filter((point) => point.kind === 'client'), [data.points]);

  const cityCenters = useMemo(() => {
    const totals = new Map<string, { lat: number; lng: number; count: number }>();
    for (const point of clientPoints) {
      const key = fold(point.city);
      if (!key) continue;
      const current = totals.get(key) || { lat: 0, lng: 0, count: 0 };
      current.lat += point.lat;
      current.lng += point.lng;
      current.count += 1;
      totals.set(key, current);
    }
    const result = new Map<string, [number, number]>();
    for (const [key, value] of totals) result.set(key, [value.lat / value.count, value.lng / value.count]);
    for (const base of TECHNICAL_BASES) {
      if (!result.has(fold(base.branch))) result.set(fold(base.branch), [base.lat, base.lng]);
    }
    return result;
  }, [clientPoints]);

  const serverAppointmentById = useMemo(() => {
    const map = new Map<string, MapPoint>();
    for (const point of data.points) {
      if (point.kind !== 'appointment') continue;
      map.set(point.id.replace('appointment:', ''), point);
    }
    return map;
  }, [data.points]);

  const visibleAgenda = useMemo(() => appointments
    .filter((item) => !technicianIds.length || technicianIds.includes(item.technician_id))
    .slice()
    .sort((a, b) => a.appointment_date.localeCompare(b.appointment_date) || a.id.localeCompare(b.id)), [appointments, technicianIds]);

  const appointmentPoints = useMemo(() => visibleAgenda.flatMap((appointment) => {
    const serverPoint = serverAppointmentById.get(appointment.id);
    const technicianName = technicians.find((item) => item.id === appointment.technician_id)?.name || null;
    if (serverPoint) {
      return [{
        ...serverPoint,
        appointment_date: appointment.appointment_date,
        technician_id: appointment.technician_id,
        technician_name: technicianName,
        client_name: appointment.client_name,
        equipment_serial: appointment.equipment_serial,
        service_city: appointment.service_city,
        service_reason: appointment.service_reason,
        description: appointment.description,
      }];
    }

    const city = String(appointment.service_city || '').trim();
    const center = cityCenters.get(fold(city));
    if (!center) return [];
    return [{
      id: `appointment:${appointment.id}`,
      kind: 'appointment' as const,
      lat: center[0],
      lng: center[1],
      precision: 'city',
      branch: appointment.branch,
      city,
      appointment_date: appointment.appointment_date,
      technician_id: appointment.technician_id,
      technician_name: technicianName,
      client_name: appointment.client_name,
      equipment_serial: appointment.equipment_serial,
      service_city: appointment.service_city,
      service_reason: appointment.service_reason,
      description: appointment.description,
      location_source: 'agenda-city-fallback',
    }];
  }), [cityCenters, serverAppointmentById, technicians, visibleAgenda]);

  const routeAppointmentPoints = useMemo(() => routeTechnicianId
    ? appointmentPoints.filter((point) => point.technician_id === routeTechnicianId)
    : [], [appointmentPoints, routeTechnicianId]);

  const automaticRoute = useMemo<[number, number][]>(() => {
    const route: [number, number][] = [];
    for (const point of routeAppointmentPoints) {
      const coordinate: [number, number] = [point.lat, point.lng];
      const previous = route[route.length - 1];
      if (!previous || Math.abs(previous[0] - coordinate[0]) > 0.00015 || Math.abs(previous[1] - coordinate[1]) > 0.00015) route.push(coordinate);
    }
    return route;
  }, [routeAppointmentPoints]);

  const fitPoints = useMemo(() => routeTechnicianId
    ? routeAppointmentPoints
    : [...data.points.filter((point) => point.kind !== 'appointment'), ...appointmentPoints], [appointmentPoints, data.points, routeAppointmentPoints, routeTechnicianId]);

  const locatedClients = data.located_clients ?? clientPoints.length;
  const requestedClients = data.requested_clients ?? clients.length;

  return <div className="retention-map-shell">
    <div className="map-toolbar">
      <div>
        <strong>Mapa de retenção</strong>
        <span>{weekLabel} · {requestedClients.toLocaleString('pt-BR')} clientes analisados</span>
      </div>
      <div className="map-toolbar-actions">
        <CheckboxMultiSelect label="Técnico" items={scheduledTechnicians.map((technician) => ({ value: technician.id, label: technician.name }))} selected={technicianIds} onChange={setTechnicianIds} allLabel="Todos os técnicos" compact />
        <button type="button" className="subtle-button" onClick={() => void loadMap()} disabled={loading}>{loading ? <Loader2 className="spin" size={15}/> : <RefreshCw size={15}/>} Atualizar</button>
      </div>
    </div>

    <div className="map-legend interactive">
      {retentionRecency.map((item) => <button type="button" key={item.key} className={recencyFilter === item.key ? 'active' : ''} onClick={() => onRecencyFilter(recencyFilter === item.key ? null : item.key)} title={recencyFilter === item.key ? 'Clique novamente para remover o filtro' : `Filtrar ${item.label}`}><i style={{ background: item.color }}/>{item.label}</button>)}
      <span>🏠 base técnica</span>
      <span>🧑‍🔧 agenda numerada</span>
      <span>🚗 deslocamento</span>
      <span>━ rota automática</span>
    </div>

    {error && <div className="map-message error">{error}</div>}
    {!error && data.points.length === 0 && loading && <div className="map-message"><Loader2 className="spin" size={18}/> Preparando mapa completo...</div>}

    <div className="retention-map">
      <MapContainer center={[-10.5, -52]} zoom={4} scrollWheelZoom preferCanvas className="leaflet-map">
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <FitMap points={fitPoints} route={automaticRoute} />

        {routeTechnicianId && automaticRoute.length >= 2 ? <Polyline positions={automaticRoute} pathOptions={{ color: '#1d4ed8', weight: 6, opacity: 0.88 }} /> : null}

        {clientPoints.map((point) => {
          const client = point.client_key ? clientByKey.get(point.client_key) : undefined;
          if (!client) return null;
          const serials = serialsByClient[retentionKey(client.client_name, client.branch)] || [];
          const color = recencyColor(point.last_service_at);
          const emphasized = Boolean(routeTechnicianId && point.near_route);
          return <CircleMarker key={point.id} center={visiblePosition(point)} radius={emphasized ? 8 : routeTechnicianId ? 5 : 6} pathOptions={{ color: emphasized ? '#0f172a' : '#fff', weight: emphasized ? 2.5 : 1.5, fillColor: color, fillOpacity: emphasized ? 1 : routeTechnicianId ? 0.48 : 0.9 }}>
            <Tooltip direction="top" offset={[0, -5]}>{client.client_name}{emphasized && point.route_distance_km != null ? ` · ${point.route_distance_km} km da rota` : ''}</Tooltip>
            <Popup minWidth={250}>
              <div className="map-popup-card">
                <strong>{client.client_name}</strong>
                <span>{client.city || 'Cidade não informada'} · {serials.length} máquina{serials.length === 1 ? '' : 's'}</span>
                <small>{point.last_service_at ? `Último atendimento: ${dateFmt.format(new Date(point.last_service_at))}` : 'Sem data de atendimento'}</small>
                {point.precision === 'city' && <small>Posição aproximada pela cidade</small>}
                {point.precision !== 'city' && point.location_label && <small>Endereço localizado: {point.location_label}</small>}
                {emphasized && point.route_distance_km != null && <small className="near-route-note">Aprox. {point.route_distance_km} km da rota do técnico</small>}
                {serials.length > 0 && <small className="map-popup-serial">{serials.slice(0, 2).join(' · ')}{serials.length > 2 ? ` +${serials.length - 2}` : ''}</small>}
                <div className="map-popup-actions">
                  <button type="button" onClick={() => onOpen(client)}>Ver ficha</button>
                  <button type="button" onClick={() => onFollowup(client)}>Follow-up</button>
                  <button type="button" className="map-primary-action" onClick={() => onSchedule(client, serials.length === 1 ? serials[0] : '', routeTechnicianId)}><CalendarPlus size={13}/> Agendar</button>
                </div>
              </div>
            </Popup>
          </CircleMarker>;
        })}

        {appointmentPoints.map((point, index) => {
          const appointmentId = point.id.replace('appointment:', '');
          const sequence = sequenceByAppointment.get(appointmentId) || index + 1;
          const selected = Boolean(routeTechnicianId && point.technician_id === routeTechnicianId);
          const travel = isTravelAppointment(point);
          const dayLabel = point.appointment_date ? relativeDayLabel(point.appointment_date) : 'AGENDA';
          const tooltip = `${travel ? 'Deslocamento' : `Agenda ${sequence}`} · ${point.technician_name || 'Técnico'}${point.service_city ? ` · ${point.service_city}` : ''}`;
          return <Marker key={point.id} position={agendaVisiblePosition(appointmentPoints, index)} icon={agendaIcon(sequence, travel)} zIndexOffset={selected ? 1200 : 800}>
            <Tooltip permanent={selected} direction="top" offset={[0, -21]} className="technician-tooltip">{selected ? `${sequence}. ${dayLabel} · ${point.service_city || point.city || 'Destino'}` : tooltip}</Tooltip>
            <Popup minWidth={260}>
              <div className="map-popup-card technician-card">
                <strong>{travel ? `🚗 Deslocamento ${sequence}` : `🧑‍🔧 Agenda ${sequence}`} · {point.technician_name || 'Técnico agendado'}</strong>
                <span>{point.appointment_date ? dateFmt.format(new Date(`${point.appointment_date}T12:00:00`)) : ''} · {point.service_city || point.city || 'Cidade não informada'}</span>
                {!travel && <small>{point.client_name || 'Cliente não informado'}</small>}
                {travel && <small>Deslocamento registrado na agenda.</small>}
                {point.service_reason && <small>{point.service_reason}</small>}
                {point.equipment_serial && <small>{point.equipment_serial}</small>}
              </div>
            </Popup>
          </Marker>;
        })}

        {TECHNICAL_BASES.map((base) => <Marker key={`base:${base.branch}`} position={[base.lat, base.lng]} icon={branchMarkerIcon} zIndexOffset={600}><Tooltip direction="top" offset={[0, -18]}>{base.name}</Tooltip><Popup><strong>{base.name}</strong><br/><small>Base técnica</small></Popup></Marker>)}
      </MapContainer>
    </div>

    <div className="map-footer">
      <div><MapPinned size={15}/><span>{locatedClients.toLocaleString('pt-BR')} de {requestedClients.toLocaleString('pt-BR')} clientes no mapa</span></div>
      {routeTechnicianId && <div><Route size={15}/><span>{routeLabel}: {routeAppointmentPoints.length} agenda{routeAppointmentPoints.length === 1 ? '' : 's'} na semana{automaticRoute.length >= 2 ? ` · ${automaticRoute.length} cidades/pontos na rota` : ' · sem mudança de cidade até agora'}{data.route?.nearby_clients != null ? ` · ${data.route.nearby_clients} clientes próximos` : ''}</span></div>}
      {technicianIds.length > 1 && <div><span>{technicianIds.length} técnicos selecionados · selecione apenas 1 para destacar a rota</span></div>}
      {data.unresolved > 0 && <div className="map-unresolved"><span>{data.unresolved} clientes sem localização suficiente</span></div>}
    </div>
    <div className="map-attribution-note">Mapa © OpenStreetMap · a rota é construída automaticamente pela sequência real da agenda; atendimentos repetidos no mesmo local aparecem separados e a linha continua quando surgir o próximo destino.</div>
  </div>;
}
