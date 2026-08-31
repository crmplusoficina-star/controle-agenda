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
};

type MapResponse = {
  points: MapPoint[];
  route: {
    technician_id: string;
    approximate: boolean;
    routing_error?: boolean;
    origin_label: string;
    geometry: [number, number][];
    distance_km?: number;
    duration_min?: number;
  } | null;
  unresolved: number;
  geocoded_now: number;
  requested_clients?: number;
  located_clients?: number;
};

type RoadStats = { distance_km: number; duration_min: number };
type RoadSegment = {
  fromSequence: number;
  toSequence: number;
  fromLabel: string;
  toLabel: string;
  geometry: [number, number][];
  stats: RoadStats;
};
type RoadRoute = { technicianId: string; geometry: [number, number][]; stats?: RoadStats; segments: RoadSegment[] };

function localIso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function relativeDayLabel(dateValue: string) {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dateValue === localIso(today)) return 'HOJE';
  if (dateValue === localIso(tomorrow)) return 'AMANHÃ';
  return shortDayFmt.format(new Date(`${dateValue}T12:00:00`)).replace('.', '').toUpperCase();
}

function fold(value?: string | null) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function serialKey(value?: string | null) {
  return fold(value).replace(/[^a-z0-9]/g, '');
}

function isTravelAppointment(point: Pick<MapPoint, 'service_reason' | 'description' | 'client_name'>) {
  const text = fold(`${point.service_reason || ''} ${point.description || ''} ${point.client_name || ''}`);
  return text.includes('deslocamento') || text.includes('desloc') || text.includes('viagem');
}

function isBrazilPoint(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -34.5 && lat <= 6.0 && lng >= -74.5 && lng <= -32.0;
}

function haversineKm(a: [number, number], b: [number, number]) {
  const rad = (value: number) => value * Math.PI / 180;
  const earth = 6371;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const lat1 = rad(a[0]);
  const lat2 = rad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

function median(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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

const branchMarkerIcon = L.divIcon({
  className: '',
  html: '<div style="width:34px;height:34px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:18px;background:#fff;border:2px solid #0f172a;box-shadow:0 4px 10px rgba(15,23,42,.22);box-sizing:border-box">🏠</div>',
  iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -18],
});

function agendaIcon(sequence: number, travel = false) {
  const emoji = travel ? '🚗' : '🧑‍🔧';
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:40px;height:40px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:19px;background:${travel ? '#fef3c7' : '#dbeafe'};border:3px solid ${travel ? '#d97706' : '#1d4ed8'};box-shadow:0 5px 14px rgba(15,23,42,.28);box-sizing:border-box">${emoji}<b style="position:absolute;right:-6px;top:-7px;min-width:18px;height:18px;padding:0 4px;border-radius:999px;background:#0f172a;color:white;border:2px solid white;font:800 10px/14px Arial;text-align:center;box-sizing:border-box">${sequence}</b></div>`,
    iconSize: [40, 40], iconAnchor: [20, 20], popupAnchor: [0, -21],
  });
}

function FitMap({ points, route }: { points: MapPoint[]; route: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    const coordinates: [number, number][] = route.length ? route : points.map((point) => point.kind === 'client' ? visiblePosition(point) : [point.lat, point.lng]);
    if (!coordinates.length) return;
    if (coordinates.length === 1) return void map.setView(coordinates[0], 11);
    map.fitBounds(L.latLngBounds(coordinates), { padding: [35, 35], maxZoom: 12 });
  }, [map, points, route]);
  return null;
}

function durationLabel(minutes?: number) {
  if (minutes == null) return '';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours ? `${hours}h${mins ? ` ${mins}min` : ''}` : `${mins}min`;
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
  const [roadRoutes, setRoadRoutes] = useState<RoadRoute[]>([]);
  const [roadErrorIds, setRoadErrorIds] = useState<string[]>([]);

  useEffect(() => {
    const available = new Set(scheduledTechnicians.map((technician) => technician.id));
    setTechnicianIds((current) => current.filter((id) => available.has(id)));
  }, [scheduledTechnicians]);

  const routeTechnicianId = technicianIds.length === 1
    ? technicianIds[0]
    : technicianIds.length === 0 && scheduledTechnicians.length === 1
      ? scheduledTechnicians[0].id
      : '';
  const clientByKey = useMemo(() => new Map(clients.map((client) => [client.client_key, client])), [clients]);
  const clientKeysBySerial = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const client of clients) {
      const serials = serialsByClient[retentionKey(client.client_name, client.branch)] || [];
      for (const serial of serials) {
        const key = serialKey(serial);
        if (!key) continue;
        const current = map.get(key) || [];
        if (!current.includes(client.client_key)) current.push(client.client_key);
        map.set(key, current);
      }
    }
    return map;
  }, [clients, serialsByClient]);

  const selectedAgenda = useMemo(() => appointments.filter((item) => !routeTechnicianId || item.technician_id === routeTechnicianId).slice().sort((a, b) => a.appointment_date.localeCompare(b.appointment_date) || a.id.localeCompare(b.id)), [appointments, routeTechnicianId]);
  const sequenceByAppointment = useMemo(() => {
    const map = new Map<string, number>();
    const counters = new Map<string, number>();
    for (const item of selectedAgenda) {
      const next = (counters.get(item.technician_id) || 0) + 1;
      counters.set(item.technician_id, next);
      map.set(item.id, next);
    }
    return map;
  }, [selectedAgenda]);

  const loadMap = useCallback(async () => {
    setLoading(true);
    setError('');
    const payloadClients = clients.map((client) => ({ client_key: client.client_key, client_name: client.client_name, branch: client.branch, city: client.city, last_service_at: client.last_service_at }));
    const visibleAppointments = technicianIds.length ? appointments.filter((item) => technicianIds.includes(item.technician_id)) : appointments;
    const payloadAppointments = visibleAppointments.map((item) => ({
      id: item.id, branch: item.branch, appointment_date: item.appointment_date, technician_id: item.technician_id,
      technician_name: technicians.find((technician) => technician.id === item.technician_id)?.name || null,
      client_name: item.client_name, equipment_serial: item.equipment_serial, service_city: item.service_city,
      service_reason: item.service_reason, description: item.description,
    }));
    const { data: response, error: invokeError } = await supabase.functions.invoke('retention-map-context', { body: { clients: payloadClients, appointments: payloadAppointments, technician_id: routeTechnicianId || null } });
    if (invokeError) setError('Não consegui carregar os pontos do mapa agora.');
    else setData((response || { points: [], route: null, unresolved: 0, geocoded_now: 0 }) as MapResponse);
    setLoading(false);
  }, [appointments, clients, routeTechnicianId, technicianIds, technicians]);

  useEffect(() => { void loadMap(); }, [loadMap]);

  const routeLabel = routeTechnicianId ? scheduledTechnicians.find((technician) => technician.id === routeTechnicianId)?.name || 'Técnico selecionado' : '';
  const clientPoints = useMemo(() => data.points.filter((point) => point.kind === 'client' && isBrazilPoint(point.lat, point.lng)), [data.points]);

  const cityCenters = useMemo(() => {
    type Coordinates = { lat: number[]; lng: number[]; states: Set<string> };
    const branchCityGroups = new Map<string, Coordinates>();
    const cityGroups = new Map<string, Coordinates>();
    const add = (map: Map<string, Coordinates>, key: string, point: MapPoint) => {
      const current = map.get(key) || { lat: [], lng: [], states: new Set<string>() };
      current.lat.push(point.lat);
      current.lng.push(point.lng);
      if (point.state) current.states.add(fold(point.state));
      map.set(key, current);
    };
    for (const point of clientPoints) {
      const cityKey = fold(point.city);
      if (!cityKey) continue;
      add(cityGroups, cityKey, point);
      if (point.branch) add(branchCityGroups, `${fold(point.branch)}|${cityKey}`, point);
    }
    const byBranchCity = new Map<string, [number, number]>();
    for (const [key, group] of branchCityGroups) byBranchCity.set(key, [median(group.lat), median(group.lng)]);
    const byUniqueCity = new Map<string, [number, number]>();
    for (const [key, group] of cityGroups) if (group.states.size <= 1) byUniqueCity.set(key, [median(group.lat), median(group.lng)]);
    return { byBranchCity, byUniqueCity };
  }, [clientPoints]);

  const serverAppointmentById = useMemo(() => {
    const map = new Map<string, MapPoint>();
    for (const point of data.points) if (point.kind === 'appointment') map.set(point.id.replace('appointment:', ''), point);
    return map;
  }, [data.points]);

  const visibleAgenda = useMemo(() => appointments.filter((item) => !technicianIds.length || technicianIds.includes(item.technician_id)).slice().sort((a, b) => a.appointment_date.localeCompare(b.appointment_date) || a.id.localeCompare(b.id)), [appointments, technicianIds]);

  const appointmentPoints = useMemo(() => visibleAgenda.flatMap((appointment) => {
    const city = String(appointment.service_city || '').trim();
    const cityKey = fold(city);
    const technicianName = technicians.find((item) => item.id === appointment.technician_id)?.name || null;
    const serialMatches = clientKeysBySerial.get(serialKey(appointment.equipment_serial)) || [];
    const serialClientPoint = clientPoints.find((point) => {
      if (!point.client_key || !serialMatches.includes(point.client_key)) return false;
      const client = clientByKey.get(point.client_key);
      if (!client) return false;
      return fold(client.branch) === fold(appointment.branch) && (!cityKey || fold(client.city) === cityKey);
    });
    const nameClientPoint = clientPoints.find((point) => {
      if (!point.client_key) return false;
      const client = clientByKey.get(point.client_key);
      if (!client) return false;
      return fold(client.client_name) === fold(appointment.client_name)
        && fold(client.branch) === fold(appointment.branch)
        && (!cityKey || fold(client.city) === cityKey);
    });
    const matchingClientPoint = serialClientPoint || nameClientPoint;
    const matchingClientPosition = matchingClientPoint ? visiblePosition(matchingClientPoint) : undefined;
    const branchCity = cityCenters.byBranchCity.get(`${fold(appointment.branch)}|${cityKey}`);
    const uniqueCity = cityCenters.byUniqueCity.get(cityKey);
    const trustedCenter: [number, number] | undefined = matchingClientPosition || branchCity || uniqueCity;

    const serverPoint = serverAppointmentById.get(appointment.id);
    const serverValid = Boolean(serverPoint
      && isBrazilPoint(serverPoint.lat, serverPoint.lng)
      && (!trustedCenter || haversineKm([serverPoint.lat, serverPoint.lng], trustedCenter) <= 100));

    let position: [number, number] | undefined;
    let precision = 'city';
    let locationSource = '';
    let locationLabel: string | null = null;

    if (matchingClientPoint && matchingClientPosition) {
      position = matchingClientPosition;
      precision = matchingClientPoint.precision || 'city';
      locationSource = serialClientPoint ? 'trusted-client-serial-position' : 'trusted-client-name-position';
      locationLabel = matchingClientPoint.location_label || null;
    } else if (serverValid && serverPoint) {
      position = [serverPoint.lat, serverPoint.lng];
      precision = serverPoint.precision || 'city';
      locationSource = serverPoint.location_source || 'server';
      locationLabel = serverPoint.location_label || null;
    } else if (trustedCenter) {
      position = trustedCenter;
      locationSource = branchCity ? 'trusted-branch-city-center' : 'trusted-city-center';
    } else {
      const base = TECHNICAL_BASES.find((item) => fold(item.branch) === fold(appointment.branch) && fold(item.branch) === cityKey);
      if (base) {
        position = [base.lat, base.lng];
        locationSource = 'technical-base-city';
      }
    }

    if (!position) return [];
    return [{
      id: `appointment:${appointment.id}`, kind: 'appointment' as const, lat: position[0], lng: position[1], precision,
      branch: appointment.branch, city, appointment_date: appointment.appointment_date, technician_id: appointment.technician_id,
      technician_name: technicianName, client_name: appointment.client_name, equipment_serial: appointment.equipment_serial,
      service_city: appointment.service_city, service_reason: appointment.service_reason, description: appointment.description,
      location_source: locationSource, location_label: locationLabel,
    }];
  }), [cityCenters, clientByKey, clientKeysBySerial, clientPoints, serverAppointmentById, technicians, visibleAgenda]);

  const displayedAppointmentPositions = useMemo(() => {
    const map = new Map<string, [number, number]>();
    appointmentPoints.forEach((point, index) => map.set(point.id, agendaVisiblePosition(appointmentPoints, index)));
    return map;
  }, [appointmentPoints]);

  const routeGroups = useMemo(() => {
    const groups = new Map<string, MapPoint[]>();
    for (const point of appointmentPoints) {
      if (!point.technician_id) continue;
      const current = groups.get(point.technician_id) || [];
      current.push(point);
      groups.set(point.technician_id, current);
    }
    return Array.from(groups.entries()).map(([technicianId, points]) => ({ technicianId, points }));
  }, [appointmentPoints]);

  const routeAppointmentPoints = useMemo(() => routeTechnicianId ? (routeGroups.find((group) => group.technicianId === routeTechnicianId)?.points || []) : [], [routeGroups, routeTechnicianId]);

  useEffect(() => {
    const controller = new AbortController();
    setRoadRoutes([]);
    setRoadErrorIds([]);

    const candidates = routeGroups.filter((group) => group.points.length >= 2 && (!technicianIds.length || technicianIds.includes(group.technicianId)));
    if (!candidates.length) return () => controller.abort();

    const serverFallback = data.route && !data.route.approximate && !data.route.routing_error && data.route.geometry?.length >= 2
      ? data.route
      : null;

    void Promise.all(candidates.map(async (group) => {
      const stopItems: { point: MapPoint; position: [number, number] }[] = [];
      for (const point of group.points) {
        const position = displayedAppointmentPositions.get(point.id) || [point.lat, point.lng] as [number, number];
        if (!stopItems.length || haversineKm(stopItems[stopItems.length - 1].position, position) > 0.005) stopItems.push({ point, position });
      }
      if (stopItems.length < 2) return null;

      const coords = stopItems.map(({ position: [lat, lng] }) => `${lng},${lat}`).join(';');
      try {
        const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`, { signal: controller.signal });
        if (!response.ok) throw new Error('routing_failed');
        const json = await response.json();
        const best = json?.routes?.[0];
        const geometry = best?.geometry?.coordinates;
        const legs = best?.legs;
        if (!Array.isArray(geometry) || geometry.length < 2 || !Array.isArray(legs)) throw new Error('routing_failed');

        const segments: RoadSegment[] = legs.flatMap((leg: any, index: number) => {
          const stepCoordinates = Array.isArray(leg?.steps)
            ? leg.steps.flatMap((step: any) => Array.isArray(step?.geometry?.coordinates) ? step.geometry.coordinates : [])
            : [];
          if (stepCoordinates.length < 2 || !stopItems[index] || !stopItems[index + 1]) return [];
          const fromPoint = stopItems[index].point;
          const toPoint = stopItems[index + 1].point;
          const fromId = fromPoint.id.replace('appointment:', '');
          const toId = toPoint.id.replace('appointment:', '');
          return [{
            fromSequence: sequenceByAppointment.get(fromId) || index + 1,
            toSequence: sequenceByAppointment.get(toId) || index + 2,
            fromLabel: fromPoint.client_name || fromPoint.service_city || fromPoint.city || 'Atendimento',
            toLabel: toPoint.client_name || toPoint.service_city || toPoint.city || 'Atendimento',
            geometry: stepCoordinates.map((item: number[]) => [Number(item[1]), Number(item[0])] as [number, number]),
            stats: {
              distance_km: Math.round((Number(leg.distance || 0) / 1000) * 10) / 10,
              duration_min: Math.round(Number(leg.duration || 0) / 60),
            },
          }];
        });

        return {
          technicianId: group.technicianId,
          geometry: geometry.map((item: number[]) => [Number(item[1]), Number(item[0])] as [number, number]),
          stats: { distance_km: Math.round((Number(best.distance || 0) / 1000) * 10) / 10, duration_min: Math.round(Number(best.duration || 0) / 60) },
          segments,
        } satisfies RoadRoute;
      } catch (routeError: any) {
        if (routeError?.name === 'AbortError') return null;
        if (serverFallback && serverFallback.technician_id === group.technicianId) {
          return {
            technicianId: group.technicianId,
            geometry: serverFallback.geometry,
            stats: serverFallback.distance_km != null && serverFallback.duration_min != null
              ? { distance_km: serverFallback.distance_km, duration_min: serverFallback.duration_min }
              : undefined,
            segments: [],
          } satisfies RoadRoute;
        }
        setRoadErrorIds((current) => current.includes(group.technicianId) ? current : [...current, group.technicianId]);
        return null;
      }
    })).then((routes) => {
      if (controller.signal.aborted) return;
      setRoadRoutes(routes.filter((route): route is RoadRoute => Boolean(route)));
    });

    return () => controller.abort();
  }, [data.route, displayedAppointmentPositions, routeGroups, sequenceByAppointment, technicianIds]);

  const selectedRoadRoute = routeTechnicianId ? roadRoutes.find((route) => route.technicianId === routeTechnicianId) : undefined;
  const fitRoute = routeTechnicianId
    ? selectedRoadRoute?.geometry || []
    : roadRoutes.flatMap((route) => route.geometry);
  const fitPoints = useMemo(() => routeTechnicianId ? routeAppointmentPoints : [...data.points.filter((point) => point.kind !== 'appointment' && (point.kind !== 'client' || isBrazilPoint(point.lat, point.lng))), ...appointmentPoints], [appointmentPoints, data.points, routeAppointmentPoints, routeTechnicianId]);
  const locatedClients = data.located_clients ?? clientPoints.length;
  const requestedClients = data.requested_clients ?? clients.length;

  return <div className="retention-map-shell">
    <div className="map-toolbar">
      <div><strong>Mapa de retenção</strong><span>{weekLabel} · {requestedClients.toLocaleString('pt-BR')} clientes analisados</span></div>
      <div className="map-toolbar-actions">
        <CheckboxMultiSelect label="Técnico" items={scheduledTechnicians.map((technician) => ({ value: technician.id, label: technician.name }))} selected={technicianIds} onChange={setTechnicianIds} allLabel="Todos os técnicos" compact />
        <button type="button" className="subtle-button" onClick={() => void loadMap()} disabled={loading}>{loading ? <Loader2 className="spin" size={15}/> : <RefreshCw size={15}/>} Atualizar</button>
      </div>
    </div>

    <div className="map-legend interactive">
      {retentionRecency.map((item) => <button type="button" key={item.key} className={recencyFilter === item.key ? 'active' : ''} onClick={() => onRecencyFilter(recencyFilter === item.key ? null : item.key)} title={recencyFilter === item.key ? 'Clique novamente para remover o filtro' : `Filtrar ${item.label}`}><i style={{ background: item.color }}/>{item.label}</button>)}
      <span>🏠 base técnica</span><span>🧑‍🔧 agenda numerada</span><span>🚗 deslocamento</span><span>┄ rota por rodovia</span>
    </div>

    {error && <div className="map-message error">{error}</div>}
    {!error && data.points.length === 0 && loading && <div className="map-message"><Loader2 className="spin" size={18}/> Preparando mapa completo...</div>}
    {routeTechnicianId && roadErrorIds.includes(routeTechnicianId) && routeAppointmentPoints.length >= 2 && <div className="map-message error">Os atendimentos estão localizados, mas a malha rodoviária não respondeu agora.</div>}

    <div className="retention-map">
      <MapContainer center={[-10.5, -52]} zoom={4} scrollWheelZoom preferCanvas className="leaflet-map">
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <FitMap points={fitPoints} route={fitRoute} />
        {roadRoutes.flatMap((route) => route.segments.length
          ? route.segments.map((segment) => <Polyline key={`road:${route.technicianId}:${segment.fromSequence}-${segment.toSequence}`} positions={segment.geometry} pathOptions={{ color: '#1d4ed8', weight: routeTechnicianId === route.technicianId ? 6 : 5, opacity: routeTechnicianId && routeTechnicianId !== route.technicianId ? 0.35 : 0.9, dashArray: '10 8' }}>
              <Tooltip sticky>Agenda {segment.fromSequence} → {segment.toSequence} · {segment.stats.distance_km.toLocaleString('pt-BR')} km · {durationLabel(segment.stats.duration_min)}</Tooltip>
              <Popup minWidth={245}><div className="map-popup-card technician-card">
                <strong>🚙 Agenda {segment.fromSequence} → Agenda {segment.toSequence}</strong>
                <span>{segment.fromLabel} → {segment.toLabel}</span>
                <small>Distância pela malha viária: {segment.stats.distance_km.toLocaleString('pt-BR')} km</small>
                <small>Tempo estimado de deslocamento: {durationLabel(segment.stats.duration_min)}</small>
              </div></Popup>
            </Polyline>)
          : [<Polyline key={`road:${route.technicianId}:full`} positions={route.geometry} pathOptions={{ color: '#1d4ed8', weight: routeTechnicianId === route.technicianId ? 5 : 4, opacity: routeTechnicianId && routeTechnicianId !== route.technicianId ? 0.35 : 0.9, dashArray: '10 8' }} />])}

        {clientPoints.map((point) => {
          const client = point.client_key ? clientByKey.get(point.client_key) : undefined;
          if (!client) return null;
          const serials = serialsByClient[retentionKey(client.client_name, client.branch)] || [];
          return <CircleMarker key={point.id} center={visiblePosition(point)} radius={6} pathOptions={{ color: '#fff', weight: 1.5, fillColor: recencyColor(point.last_service_at), fillOpacity: 0.9 }}>
            <Tooltip direction="top" offset={[0, -5]}>{client.client_name}</Tooltip>
            <Popup minWidth={250}><div className="map-popup-card">
              <strong>{client.client_name}</strong><span>{client.city || 'Cidade não informada'} · {serials.length} máquina{serials.length === 1 ? '' : 's'}</span>
              <small>{point.last_service_at ? `Último atendimento: ${dateFmt.format(new Date(point.last_service_at))}` : 'Sem data de atendimento'}</small>
              {point.precision === 'city' && <small>Posição aproximada pela cidade</small>}
              {point.precision !== 'city' && point.location_label && <small>Endereço localizado: {point.location_label}</small>}
              {serials.length > 0 && <small className="map-popup-serial">{serials.slice(0, 2).join(' · ')}{serials.length > 2 ? ` +${serials.length - 2}` : ''}</small>}
              <div className="map-popup-actions"><button type="button" onClick={() => onOpen(client)}>Ver ficha</button><button type="button" onClick={() => onFollowup(client)}>Follow-up</button><button type="button" className="map-primary-action" onClick={() => onSchedule(client, serials.length === 1 ? serials[0] : '', routeTechnicianId)}><CalendarPlus size={13}/> Agendar</button></div>
            </div></Popup>
          </CircleMarker>;
        })}

        {appointmentPoints.map((point, index) => {
          const appointmentId = point.id.replace('appointment:', '');
          const sequence = sequenceByAppointment.get(appointmentId) || index + 1;
          const selected = Boolean(routeTechnicianId && point.technician_id === routeTechnicianId);
          const travel = isTravelAppointment(point);
          const dayLabel = point.appointment_date ? relativeDayLabel(point.appointment_date) : 'AGENDA';
          const tooltip = `${travel ? 'Deslocamento' : `Agenda ${sequence}`} · ${point.technician_name || 'Técnico'}${point.service_city ? ` · ${point.service_city}` : ''}`;
          return <Marker key={point.id} position={displayedAppointmentPositions.get(point.id) || [point.lat, point.lng]} icon={agendaIcon(sequence, travel)} zIndexOffset={selected ? 1200 : 800}>
            <Tooltip permanent={selected} direction="top" offset={[0, -21]} className="technician-tooltip">{selected ? `${sequence}. ${dayLabel} · ${point.service_city || point.city || 'Destino'}` : tooltip}</Tooltip>
            <Popup minWidth={260}><div className="map-popup-card technician-card">
              <strong>{travel ? `🚗 Deslocamento ${sequence}` : `🧑‍🔧 Agenda ${sequence}`} · {point.technician_name || 'Técnico agendado'}</strong>
              <span>{point.appointment_date ? dateFmt.format(new Date(`${point.appointment_date}T12:00:00`)) : ''} · {point.service_city || point.city || 'Cidade não informada'}</span>
              {!travel && <small>{point.client_name || 'Cliente não informado'}</small>}
              {travel && <small>Deslocamento registrado na agenda.</small>}
              {point.service_reason && <small>{point.service_reason}</small>}{point.equipment_serial && <small>{point.equipment_serial}</small>}
            </div></Popup>
          </Marker>;
        })}

        {TECHNICAL_BASES.map((base) => <Marker key={`base:${base.branch}`} position={[base.lat, base.lng]} icon={branchMarkerIcon} zIndexOffset={600}><Tooltip direction="top" offset={[0, -18]}>{base.name}</Tooltip><Popup><strong>{base.name}</strong><br/><small>Base técnica</small></Popup></Marker>)}
      </MapContainer>
    </div>

    <div className="map-footer">
      <div><MapPinned size={15}/><span>{locatedClients.toLocaleString('pt-BR')} de {requestedClients.toLocaleString('pt-BR')} clientes no mapa</span></div>
      {routeTechnicianId && <div><Route size={15}/><span>{routeLabel}: {routeAppointmentPoints.length} agenda{routeAppointmentPoints.length === 1 ? '' : 's'} na semana{selectedRoadRoute?.stats ? ` · ${selectedRoadRoute.stats.distance_km} km · ${durationLabel(selectedRoadRoute.stats.duration_min)}` : routeAppointmentPoints.length >= 2 ? ' · calculando rota rodoviária entre atendimentos' : ' · aguardando próximo atendimento'}</span></div>}
      {!routeTechnicianId && roadRoutes.length > 0 && <div><Route size={15}/><span>{roadRoutes.length} rota{roadRoutes.length === 1 ? '' : 's'} de técnico exibida{roadRoutes.length === 1 ? '' : 's'} pela malha viária</span></div>}
      {data.unresolved > 0 && <div className="map-unresolved"><span>{data.unresolved} clientes sem localização suficiente</span></div>}
    </div>
    <div className="map-attribution-note">Mapa © OpenStreetMap · clientes mantêm o mesmo tamanho; a cor representa somente a retenção. Clique em qualquer trecho da rota para ver distância e tempo entre uma agenda e a próxima.</div>
  </div>;
}
