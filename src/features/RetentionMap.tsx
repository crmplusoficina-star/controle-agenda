import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { CalendarPlus, Loader2, MapPinned, RefreshCw, Route, UserRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Appointment, ClientSummary, Technician } from '../types';
import { daysBetween } from '../lib/date';
import 'leaflet/dist/leaflet.css';
import './retention-map.css';

const retentionKey = (clientName: string, branchName: string) => `${clientName.trim().toUpperCase()}|${branchName.trim().toUpperCase()}`;
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

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
  serials?: string[];
  appointment_date?: string;
  technician_id?: string;
  technician_name?: string | null;
  equipment_serial?: string | null;
  service_city?: string | null;
};

type MapResponse = {
  points: MapPoint[];
  route: { technician_id: string; approximate: boolean; origin_label: string; geometry: [number, number][] } | null;
  unresolved: number;
  geocoded_now: number;
};

function recencyColor(lastServiceAt?: string | null) {
  if (!lastServiceAt) return '#475569';
  const days = daysBetween(lastServiceAt.slice(0, 10));
  if (days <= 92) return '#16a34a';
  if (days <= 184) return '#f59e0b';
  if (days <= 366) return '#dc2626';
  if (days <= 550) return '#7c3aed';
  return '#475569';
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
  onOpen,
  onFollowup,
  onSchedule,
}: {
  clients: ClientSummary[];
  serialsByClient: Record<string, string[]>;
  appointments: Appointment[];
  technicians: Technician[];
  weekLabel: string;
  onOpen: (client: ClientSummary) => void;
  onFollowup: (client: ClientSummary) => void;
  onSchedule: (client: ClientSummary, serial: string, technicianId: string) => void;
}) {
  const scheduledTechnicians = useMemo(() => {
    const ids = new Set(appointments.map((item) => item.technician_id));
    return technicians.filter((technician) => ids.has(technician.id));
  }, [appointments, technicians]);

  const [technicianId, setTechnicianId] = useState('');
  const [data, setData] = useState<MapResponse>({ points: [], route: null, unresolved: 0, geocoded_now: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (technicianId && !scheduledTechnicians.some((technician) => technician.id === technicianId)) setTechnicianId('');
  }, [scheduledTechnicians, technicianId]);

  const clientByKey = useMemo(() => new Map(clients.map((client) => [client.client_key, client])), [clients]);

  const loadMap = useCallback(async () => {
    setLoading(true);
    setError('');
    const payloadClients = clients.slice(0, 40).map((client) => ({
      client_key: client.client_key,
      client_name: client.client_name,
      branch: client.branch,
      city: client.city,
      last_service_at: client.last_service_at,
      serials: serialsByClient[retentionKey(client.client_name, client.branch)] || [],
    }));
    const payloadAppointments = appointments.map((item) => ({
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
      body: { clients: payloadClients, appointments: payloadAppointments, technician_id: technicianId || null },
    });

    if (invokeError) {
      setError('Não consegui carregar os pontos do mapa agora. A lista continua disponível normalmente.');
    } else {
      setData((response || { points: [], route: null, unresolved: 0, geocoded_now: 0 }) as MapResponse);
    }
    setLoading(false);
  }, [appointments, clients, serialsByClient, technicianId, technicians]);

  useEffect(() => { void loadMap(); }, [loadMap]);

  const routeLabel = technicianId
    ? scheduledTechnicians.find((technician) => technician.id === technicianId)?.name || 'Técnico selecionado'
    : '';

  return <div className="retention-map-shell">
    <div className="map-toolbar">
      <div>
        <strong>Mapa de retenção</strong>
        <span>{weekLabel} · clientes visíveis: {Math.min(clients.length, 40)} de {clients.length}</span>
      </div>
      <div className="map-toolbar-actions">
        <label className="map-tech-filter"><UserRound size={15}/><select value={technicianId} onChange={(event) => setTechnicianId(event.target.value)}><option value="">Todos os técnicos</option>{scheduledTechnicians.map((technician) => <option key={technician.id} value={technician.id}>{technician.name}</option>)}</select></label>
        <button type="button" className="subtle-button" onClick={() => void loadMap()} disabled={loading}>{loading ? <Loader2 className="spin" size={15}/> : <RefreshCw size={15}/>} Atualizar pontos</button>
      </div>
    </div>

    <div className="map-legend">
      <span><i style={{ background: '#16a34a' }}/> até 3 meses</span>
      <span><i style={{ background: '#f59e0b' }}/> 3–6 meses</span>
      <span><i style={{ background: '#dc2626' }}/> 6–12 meses</span>
      <span><i style={{ background: '#7c3aed' }}/> 12–18 meses</span>
      <span><i style={{ background: '#475569' }}/> +18 meses</span>
      <span><i className="tech-dot"/> atendimento agendado</span>
    </div>

    {error && <div className="map-message error">{error}</div>}
    {!error && data.points.length === 0 && loading && <div className="map-message"><Loader2 className="spin" size={18}/> Localizando clientes e agenda...</div>}

    <div className="retention-map">
      <MapContainer center={[-10.5, -52]} zoom={4} scrollWheelZoom className="leaflet-map">
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <FitMap points={data.points} route={data.route} />

        {data.route?.geometry?.length ? <Polyline positions={data.route.geometry} pathOptions={{ color: '#2563eb', weight: 4, opacity: 0.72 }} /> : null}

        {data.points.filter((point) => point.kind === 'client').map((point) => {
          const client = point.client_key ? clientByKey.get(point.client_key) : undefined;
          if (!client) return null;
          const serials = point.serials || serialsByClient[retentionKey(client.client_name, client.branch)] || [];
          const color = recencyColor(point.last_service_at);
          return <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.96 }}>
            <Tooltip direction="top" offset={[0, -5]}>{client.client_name}</Tooltip>
            <Popup minWidth={250}>
              <div className="map-popup-card">
                <strong>{client.client_name}</strong>
                <span>{client.city || 'Cidade não informada'} · {serials.length} máquina{serials.length === 1 ? '' : 's'}</span>
                <small>{point.last_service_at ? `Último atendimento: ${dateFmt.format(new Date(point.last_service_at))}` : 'Sem data de atendimento'}</small>
                {serials.length > 0 && <small className="map-popup-serial">{serials.slice(0, 2).join(' · ')}{serials.length > 2 ? ` +${serials.length - 2}` : ''}</small>}
                <div className="map-popup-actions">
                  <button type="button" onClick={() => onOpen(client)}>Ver ficha</button>
                  <button type="button" onClick={() => onFollowup(client)}>Follow-up</button>
                  <button type="button" className="map-primary-action" onClick={() => onSchedule(client, serials.length === 1 ? serials[0] : '', technicianId)}><CalendarPlus size={13}/> Agendar</button>
                </div>
              </div>
            </Popup>
          </CircleMarker>;
        })}

        {data.points.filter((point) => point.kind === 'appointment').map((point) => <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={10} pathOptions={{ color: '#1d4ed8', weight: 3, fillColor: '#60a5fa', fillOpacity: 0.95 }}>
          <Tooltip permanent={Boolean(technicianId && point.technician_id === technicianId)} direction="top" offset={[0, -8]} className="technician-tooltip">{point.technician_name || 'Técnico'}</Tooltip>
          <Popup minWidth={235}><div className="map-popup-card technician-card"><strong>{point.technician_name || 'Técnico agendado'}</strong><span>{point.appointment_date ? dateFmt.format(new Date(`${point.appointment_date}T12:00:00`)) : ''} · {point.service_city || 'Cidade não informada'}</span><small>{point.client_name || 'Cliente não informado'}</small>{point.equipment_serial && <small>{point.equipment_serial}</small>}</div></Popup>
        </CircleMarker>)}

        {data.points.filter((point) => point.kind === 'branch').map((point) => <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={9} pathOptions={{ color: '#0f172a', weight: 3, fillColor: '#fff', fillOpacity: 1 }}><Tooltip direction="top">{point.name || point.branch}</Tooltip><Popup><strong>{point.name || point.branch}</strong><br/><small>Origem provável da rota semanal</small></Popup></CircleMarker>)}
      </MapContainer>
    </div>

    <div className="map-footer">
      <div><MapPinned size={15}/><span>{data.points.filter((point) => point.kind === 'client').length} clientes localizados</span></div>
      {technicianId && data.route && <div><Route size={15}/><span>{routeLabel}: rota {data.route.approximate ? 'aproximada' : 'viária'} a partir de {data.route.origin_label}</span></div>}
      {data.unresolved > 0 && <button type="button" onClick={() => void loadMap()} disabled={loading}>Localizar mais {Math.min(data.unresolved, 10)} pontos</button>}
    </div>
    <div className="map-attribution-note">Mapa © OpenStreetMap · geocodificação sob demanda com cache. A rota é apoio visual e não substitui planejamento de viagem.</div>
  </div>;
}
