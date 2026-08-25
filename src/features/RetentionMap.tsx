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
  last_service_at?: string | null;
  appointment_date?: string;
  technician_id?: string;
  technician_name?: string | null;
  equipment_serial?: string | null;
  service_city?: string | null;
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

function cityClusterIcon(count: number) {
  const size = Math.min(64, 38 + Math.round(Math.log2(Math.max(2, count)) * 5));
  return L.divIcon({
    className: 'retention-city-cluster-icon',
    html: `<div class="retention-city-cluster-bubble"><strong>${count}</strong><span>clientes</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)],
  });
}

function FitMap({ points, route }: { points: MapPoint[]; route: MapResponse['route'] }) {
  const map = useMap();
  useEffect(() => {
    const coordinates: [number, number][] = route?.geometry?.length
      ? route.geometry
      : points.map((point) => [point.lat, point.lng]);
    if (!coordinates.length) return;
    if (coordinates.length === 1) {
      map.setView(coordinates[0], 11);
      return;
    }
    map.fitBounds(L.latLngBounds(coordinates), { padding: [35, 35], maxZoom: 12 });
  }, [map, points, route]);
  return null;
}

export function RetentionMap({
  clients,
  serialsByClient,
  appointments,
  technicians,
  weekLabel,
  recencyFilter,
  onRecencyFilter,
  onOpen,
  onFollowup,
  onSchedule,
}: {
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

  const planningByAppointment = useMemo(() => {
    const result = new Map<string, { label: string; relative: 'today' | 'tomorrow' | 'later'; sequence: number; count: number }>();
    const groups = new Map<string, Appointment[]>();
    for (const item of appointments) {
      const key = `${item.technician_id}|${item.appointment_date}`;
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.id.localeCompare(b.id));
      group.forEach((item, index) => {
        const base = relativeDayLabel(item.appointment_date);
        const label = group.length > 1 ? `${base} · ${index + 1}` : base;
        const today = localIso(new Date());
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const relative = item.appointment_date === today ? 'today' : item.appointment_date === localIso(tomorrow) ? 'tomorrow' : 'later';
        result.set(item.id, { label, relative, sequence: index + 1, count: group.length });
      });
    }
    return result;
  }, [appointments]);

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
    }));

    const { data: response, error: invokeError } = await supabase.functions.invoke('retention-map-context', {
      body: { clients: payloadClients, appointments: payloadAppointments, technician_id: routeTechnicianId || null },
    });

    if (invokeError) {
      setError('Não consegui carregar os pontos do mapa agora. A lista continua disponível normalmente.');
    } else {
      setData((response || { points: [], route: null, unresolved: 0, geocoded_now: 0 }) as MapResponse);
    }
    setLoading(false);
  }, [appointments, clients, routeTechnicianId, technicianIds, technicians]);

  useEffect(() => { void loadMap(); }, [loadMap]);

  const routeLabel = routeTechnicianId
    ? scheduledTechnicians.find((technician) => technician.id === routeTechnicianId)?.name || 'Técnico selecionado'
    : '';

  const clientPoints = useMemo(() => data.points.filter((point) => point.kind === 'client'), [data.points]);
  const appointmentPoints = useMemo(() => data.points.filter((point) => point.kind === 'appointment' && (!technicianIds.length || (point.technician_id && technicianIds.includes(point.technician_id)))), [data.points, technicianIds]);
  const cityClusters = useMemo(() => {
    const groups = new Map<string, MapPoint[]>();
    for (const point of clientPoints) {
      if (point.precision !== 'city' || !point.city) continue;
      const key = `${String(point.branch || '').trim().toUpperCase()}|${point.city.trim().toUpperCase()}`;
      const group = groups.get(key) || [];
      group.push(point);
      groups.set(key, group);
    }
    return Array.from(groups.entries())
      .filter(([, points]) => points.length > 1)
      .map(([key, points]) => ({
        key,
        points,
        city: points[0].city || 'Cidade não informada',
        branch: points[0].branch || '',
        lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
        lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
        nearRouteCount: points.filter((point) => point.near_route).length,
      }));
  }, [clientPoints]);
  const clusteredClientIds = useMemo(() => new Set(cityClusters.flatMap((cluster) => cluster.points.map((point) => point.id))), [cityClusters]);
  const locatedClients = data.located_clients ?? clientPoints.length;
  const requestedClients = data.requested_clients ?? clients.length;

  return <div className="retention-map-shell">
    <div className="map-toolbar">
      <div>
        <strong>Mapa de retenção</strong>
        <span>{weekLabel} · {requestedClients.toLocaleString('pt-BR')} clientes analisados</span>
      </div>
      <div className="map-toolbar-actions">
        <CheckboxMultiSelect
          label="Técnico"
          items={scheduledTechnicians.map((technician) => ({ value: technician.id, label: technician.name }))}
          selected={technicianIds}
          onChange={setTechnicianIds}
          allLabel="Todos os técnicos"
          compact
        />
        <button type="button" className="subtle-button" onClick={() => void loadMap()} disabled={loading}>{loading ? <Loader2 className="spin" size={15}/> : <RefreshCw size={15}/>} Atualizar</button>
      </div>
    </div>

    <div className="map-legend interactive">
      {retentionRecency.map((item) => <button type="button" key={item.key} className={recencyFilter === item.key ? 'active' : ''} onClick={() => onRecencyFilter(recencyFilter === item.key ? null : item.key)} title={recencyFilter === item.key ? 'Clique novamente para remover o filtro' : `Filtrar ${item.label}`}><i style={{ background: item.color }}/>{item.label}</button>)}
      <span><i className="tech-dot"/> agenda do técnico</span>
      <span><i className="city-cluster-legend"/> vários clientes na cidade</span>
    </div>

    {error && <div className="map-message error">{error}</div>}
    {!error && data.points.length === 0 && loading && <div className="map-message"><Loader2 className="spin" size={18}/> Preparando mapa completo...</div>}

    <div className="retention-map">
      <MapContainer center={[-10.5, -52]} zoom={4} scrollWheelZoom preferCanvas className="leaflet-map">
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <FitMap points={routeTechnicianId && data.route ? [...clientPoints.filter((point) => point.near_route), ...appointmentPoints, ...data.points.filter((point) => point.kind === 'branch')] : data.points} route={data.route} />

        {data.route?.geometry?.length ? <Polyline positions={data.route.geometry} pathOptions={{ color: '#2563eb', weight: 4, opacity: 0.76 }} /> : null}

        {cityClusters.map((cluster) => {
          const clusterClients = cluster.points
            .map((point) => point.client_key ? clientByKey.get(point.client_key) : undefined)
            .filter((client): client is ClientSummary => Boolean(client));
          const recencyCounts = retentionRecency.map((item) => ({
            ...item,
            count: cluster.points.filter((point) => recencyColor(point.last_service_at) === item.color).length,
          })).filter((item) => item.count > 0);
          return <Marker key={cluster.key} position={[cluster.lat, cluster.lng]} icon={cityClusterIcon(cluster.points.length)}>
            <Tooltip direction="top" offset={[0, -12]}>{cluster.city} · {cluster.points.length} clientes</Tooltip>
            <Popup minWidth={300} maxWidth={340}>
              <div className="map-popup-card city-cluster-card">
                <strong>{cluster.city}</strong>
                <span>{cluster.points.length} clientes com localização aproximada pela cidade</span>
                {routeTechnicianId && cluster.nearRouteCount > 0 && <small className="near-route-note">{cluster.nearRouteCount} cliente{cluster.nearRouteCount === 1 ? '' : 's'} próximo{cluster.nearRouteCount === 1 ? '' : 's'} da rota selecionada</small>}
                <div className="city-cluster-recency">
                  {recencyCounts.map((item) => <span key={item.key}><i style={{ background: item.color }}/><strong>{item.count}</strong> {item.label}</span>)}
                </div>
                <div className="city-cluster-client-list">
                  {clusterClients.slice(0, 8).map((client) => <button type="button" key={client.client_key} onClick={() => onOpen(client)}>
                    <span>{client.client_name}</span>
                    <small>{client.last_service_at ? dateFmt.format(new Date(client.last_service_at)) : 'Sem data'} · {client.machine_count} máquina{client.machine_count === 1 ? '' : 's'}</small>
                  </button>)}
                </div>
                {clusterClients.length > 8 && <small className="city-cluster-more">+{clusterClients.length - 8} outros clientes nesta cidade</small>}
                <small>Os pontos são agrupados porque o G4 informa apenas a cidade, sem endereço preciso.</small>
              </div>
            </Popup>
          </Marker>;
        })}

        {clientPoints.map((point) => {
          if (clusteredClientIds.has(point.id)) return null;
          const client = point.client_key ? clientByKey.get(point.client_key) : undefined;
          if (!client) return null;
          const serials = serialsByClient[retentionKey(client.client_name, client.branch)] || [];
          const color = recencyColor(point.last_service_at);
          const emphasized = Boolean(routeTechnicianId && point.near_route);
          return <CircleMarker
            key={point.id}
            center={[point.lat, point.lng]}
            radius={emphasized ? 8 : routeTechnicianId ? 5 : 6}
            pathOptions={{ color: emphasized ? '#0f172a' : '#fff', weight: emphasized ? 2.5 : 1.5, fillColor: color, fillOpacity: emphasized ? 1 : routeTechnicianId ? 0.48 : 0.86 }}
          >
            <Tooltip direction="top" offset={[0, -5]}>{client.client_name}{emphasized && point.route_distance_km != null ? ` · ${point.route_distance_km} km da rota` : ''}</Tooltip>
            <Popup minWidth={250}>
              <div className="map-popup-card">
                <strong>{client.client_name}</strong>
                <span>{client.city || 'Cidade não informada'} · {serials.length} máquina{serials.length === 1 ? '' : 's'}</span>
                <small>{point.last_service_at ? `Último atendimento: ${dateFmt.format(new Date(point.last_service_at))}` : 'Sem data de atendimento'}</small>
                {point.precision === 'city' && <small>Localização aproximada pela cidade</small>}
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

        {appointmentPoints.map((point) => {
          const plan = planningByAppointment.get(point.id.replace('appointment:', ''));
          const selected = Boolean(routeTechnicianId && point.technician_id === routeTechnicianId);
          const isToday = plan?.relative === 'today';
          const isTomorrow = plan?.relative === 'tomorrow';
          const label = plan?.label || (point.appointment_date ? relativeDayLabel(point.appointment_date) : 'AGENDA');
          const markerColor = isToday ? '#1d4ed8' : isTomorrow ? '#3b82f6' : '#60a5fa';
          return <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={isToday ? 11 : 9.5} pathOptions={{ color: isToday ? '#0f172a' : '#1d4ed8', weight: isToday ? 4 : 3, fillColor: markerColor, fillOpacity: 0.96 }}>
            <Tooltip permanent={selected} direction="top" offset={[0, -8]} className={`technician-tooltip ${isToday ? 'today' : isTomorrow ? 'tomorrow' : ''}`}>{selected ? label : `${label} · ${point.technician_name || 'Técnico'}`}</Tooltip>
            <Popup minWidth={245}>
              <div className="map-popup-card technician-card">
                <strong>{label} · {point.technician_name || 'Técnico agendado'}</strong>
                <span>{point.appointment_date ? dateFmt.format(new Date(`${point.appointment_date}T12:00:00`)) : ''} · {point.service_city || 'Cidade não informada'}</span>
                <small>{point.client_name || 'Cliente não informado'}</small>
                {point.equipment_serial && <small>{point.equipment_serial}</small>}
                {point.precision === 'city' && <small>Posição aproximada pela cidade</small>}
              </div>
            </Popup>
          </CircleMarker>;
        })}

        {data.points.filter((point) => point.kind === 'branch').map((point) => <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={9} pathOptions={{ color: '#0f172a', weight: 3, fillColor: '#fff', fillOpacity: 1 }}><Tooltip direction="top">{point.name || point.branch}</Tooltip><Popup><strong>{point.name || point.branch}</strong><br/><small>Origem provável da rota semanal</small></Popup></CircleMarker>)}
      </MapContainer>
    </div>

    <div className="map-footer">
      <div><MapPinned size={15}/><span>{locatedClients.toLocaleString('pt-BR')} de {requestedClients.toLocaleString('pt-BR')} clientes no mapa</span></div>
      {routeTechnicianId && data.route && <div><Route size={15}/><span>{routeLabel}: {data.route.nearby_clients || 0} clientes até {data.route.radius_km || 30} km da rota</span></div>}
      {technicianIds.length > 1 && <div><span>{technicianIds.length} técnicos selecionados · selecione apenas 1 para traçar a rota</span></div>}
      {data.unresolved > 0 && <div className="map-unresolved"><span>{data.unresolved} clientes sem localização suficiente</span></div>}
    </div>
    <div className="map-attribution-note">Mapa © OpenStreetMap · pontos sem endereço são agrupados pela cidade. A rota é apoio visual e não substitui planejamento de viagem.</div>
  </div>;
}
