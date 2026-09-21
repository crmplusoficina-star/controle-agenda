import type { Appointment, Technician } from '../types';
import { supabase } from './supabase';

export type AppointmentRouteDistance = {
  distance_km: number | null;
  duration_min: number | null;
  from_label: string;
  to_label: string;
  status: 'ok' | 'unavailable';
  reason?: string;
};

export type RouteAppointmentInput = Pick<
  Appointment,
  'id' | 'branch' | 'appointment_date' | 'technician_id' | 'client_name' | 'equipment_serial' | 'service_city' | 'service_reason' | 'description'
> & {
  created_at?: string | null;
};

type RouteNode = {
  lat: number;
  lng: number;
  label: string;
  appointmentId?: string;
};

type ContextPoint = {
  id: string;
  kind: string;
  lat: number;
  lng: number;
  location_uncertain?: boolean;
};

const TECHNICAL_BASES: Record<string, { lat: number; lng: number; label: string }> = {
  BALSAS: { lat: -7.5325, lng: -46.0356, label: 'Filial BALSAS' },
  IMPERATRIZ: { lat: -5.5264, lng: -47.4917, label: 'Filial IMPERATRIZ' },
  ITAITINGA: { lat: -3.9694, lng: -38.5288, label: 'Filial ITAITINGA' },
  'SAO LUIS': { lat: -2.5307, lng: -44.3068, label: 'Filial SAO LUIS' },
  TERESINA: { lat: -5.0892, lng: -42.8019, label: 'Filial TERESINA' },
  MARITUBA: { lat: -1.355, lng: -48.342, label: 'Filial MARITUBA' },
  MARABA: { lat: -5.3686, lng: -49.1178, label: 'Filial MARABA' },
  MIRITITUBA: { lat: -4.276, lng: -55.983, label: 'Filial MIRITITUBA' },
  MANAUS: { lat: -3.119, lng: -60.0217, label: 'Filial MANAUS' },
};

function fold(value?: string | null) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function formatIso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function agendaWeekBounds(dateValue: string) {
  const date = new Date(`${dateValue}T12:00:00`);
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(date);
  start.setDate(start.getDate() + diffToMonday);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { start: formatIso(start), end: formatIso(end) };
}

function weekKey(dateValue: string) {
  return agendaWeekBounds(dateValue).start;
}

function destinationLabel(item: RouteAppointmentInput) {
  if (isExplicitBranchStop(item)) return `Filial ${item.branch}`;
  return String(item.service_city || item.client_name || 'Atendimento').trim();
}

function baseFor(branch?: string | null) {
  return TECHNICAL_BASES[fold(branch)] || null;
}

function isExplicitBranchStop(item: RouteAppointmentInput) {
  const text = fold(`${item.service_reason || ''} ${item.description || ''}`);
  if (text.includes('RETORNO') && text.includes('FILIAL')) return true;
  return !String(item.client_name || '').trim()
    && Boolean(item.service_city)
    && fold(item.service_city) === fold(item.branch);
}

function sortAppointments(a: RouteAppointmentInput, b: RouteAppointmentInput) {
  return a.appointment_date.localeCompare(b.appointment_date)
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || a.id.localeCompare(b.id);
}

async function routeNodes(nodes: RouteNode[]) {
  if (nodes.length < 2) return null;
  const coords = nodes.map((node) => `${node.lng},${node.lat}`).join(';');
  const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=false&steps=false`);
  if (!response.ok) throw new Error(`osrm_http_${response.status}`);
  const json = await response.json();
  const best = json?.routes?.[0];
  const legs = best?.legs;
  if (!Array.isArray(legs) || legs.length !== nodes.length - 1) throw new Error('osrm_invalid_route');
  return legs as Array<{ distance?: number; duration?: number }>;
}

export async function calculateAgendaRouteDistances(
  appointments: RouteAppointmentInput[],
  technicians: Technician[],
): Promise<Record<string, AppointmentRouteDistance>> {
  const result: Record<string, AppointmentRouteDistance> = {};
  const routeAppointments = appointments.filter((item) =>
    Boolean(item.technician_id && item.appointment_date)
    && (Boolean(String(item.service_city || '').trim()) || Boolean(String(item.client_name || '').trim()) || isExplicitBranchStop(item)),
  );
  if (!routeAppointments.length) return result;

  const technicianById = new Map(technicians.map((item) => [item.id, item]));
  const payloadAppointments = routeAppointments.map((item) => ({
    id: item.id,
    branch: item.branch,
    appointment_date: item.appointment_date,
    technician_id: item.technician_id,
    technician_name: technicianById.get(item.technician_id)?.name || null,
    client_name: item.client_name,
    equipment_serial: item.equipment_serial,
    service_city: item.service_city,
    service_reason: item.service_reason,
    description: item.description,
    created_at: item.created_at || null,
  }));

  let contextPoints: ContextPoint[] = [];
  try {
    const { data, error } = await supabase.functions.invoke('retention-map-context', {
      body: { clients: [], appointments: payloadAppointments, technician_id: null },
    });
    if (!error && Array.isArray((data as any)?.points)) contextPoints = (data as any).points as ContextPoint[];
  } catch {
    contextPoints = [];
  }

  const pointByAppointmentId = new Map<string, ContextPoint>();
  for (const point of contextPoints) {
    if (point.kind !== 'appointment' || point.location_uncertain) continue;
    const id = String(point.id || '').replace(/^appointment:/, '');
    if (!id || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) continue;
    pointByAppointmentId.set(id, { ...point, lat: Number(point.lat), lng: Number(point.lng) });
  }

  const groups = new Map<string, RouteAppointmentInput[]>();
  for (const item of routeAppointments) {
    const key = `${item.technician_id}|${weekKey(item.appointment_date)}`;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }

  const jobs: RouteNode[][] = [];
  for (const groupItems of groups.values()) {
    const sorted = groupItems.slice().sort(sortAppointments);
    const first = sorted[0];
    const technician = technicianById.get(first.technician_id);
    const base = baseFor(first.branch || technician?.branch || '');
    let chain: RouteNode[] = base ? [{ ...base }] : [];
    let previousLocationKnown = Boolean(base);

    for (const item of sorted) {
      const toLabel = destinationLabel(item);
      let node: RouteNode | null = null;
      if (isExplicitBranchStop(item)) {
        const branchBase = baseFor(item.branch || technician?.branch || '');
        if (branchBase) node = { ...branchBase, appointmentId: item.id, label: branchBase.label };
      } else {
        const point = pointByAppointmentId.get(item.id);
        if (point) node = { lat: point.lat, lng: point.lng, appointmentId: item.id, label: toLabel };
      }

      if (!node) {
        if (chain.length >= 2) jobs.push(chain);
        result[item.id] = {
          distance_km: null,
          duration_min: null,
          from_label: chain[chain.length - 1]?.label || 'Atendimento anterior',
          to_label: toLabel,
          status: 'unavailable',
          reason: 'Não foi possível confirmar a localização/UF deste atendimento.',
        };
        chain = [];
        previousLocationKnown = false;
        continue;
      }

      if (!previousLocationKnown) {
        result[item.id] = {
          distance_km: null,
          duration_min: null,
          from_label: 'Atendimento anterior',
          to_label: node.label,
          status: 'unavailable',
          reason: 'O local do atendimento anterior não foi identificado.',
        };
        chain = [node];
        previousLocationKnown = true;
        continue;
      }

      chain.push(node);
      previousLocationKnown = true;
    }

    if (chain.length >= 2) jobs.push(chain);
    if (!base && sorted.length && !result[sorted[0].id]) {
      result[sorted[0].id] = {
        distance_km: null,
        duration_min: null,
        from_label: `Filial ${first.branch || technician?.branch || ''}`,
        to_label: destinationLabel(sorted[0]),
        status: 'unavailable',
        reason: 'A base técnica desta filial ainda não tem coordenada configurada.',
      };
    }
  }

  await Promise.all(jobs.map(async (nodes) => {
    try {
      const legs = await routeNodes(nodes);
      if (!legs) return;
      legs.forEach((leg, index) => {
        const destination = nodes[index + 1];
        if (!destination.appointmentId) return;
        result[destination.appointmentId] = {
          distance_km: Math.round((Number(leg.distance || 0) / 1000) * 10) / 10,
          duration_min: Math.round(Number(leg.duration || 0) / 60),
          from_label: nodes[index].label,
          to_label: destination.label,
          status: 'ok',
        };
      });
    } catch {
      for (let index = 1; index < nodes.length; index += 1) {
        const destination = nodes[index];
        if (!destination.appointmentId || result[destination.appointmentId]?.status === 'unavailable') continue;
        result[destination.appointmentId] = {
          distance_km: null,
          duration_min: null,
          from_label: nodes[index - 1].label,
          to_label: destination.label,
          status: 'unavailable',
          reason: 'A malha rodoviária não respondeu agora.',
        };
      }
    }
  }));

  return result;
}
