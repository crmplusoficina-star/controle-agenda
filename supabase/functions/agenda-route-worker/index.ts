import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PAGE_SIZE = 1000;
const JOB_LIMIT = 8;
const FULL_SYNC_HOURS = 24;
const ROUTERS = [
  { name: 'osrm', base: 'https://router.project-osrm.org' },
  { name: 'osm-de', base: 'https://routing.openstreetmap.de/routed-car' },
] as const;

const stateNames: Record<string, string> = {
  AC:'Acre',AL:'Alagoas',AP:'Amapá',AM:'Amazonas',BA:'Bahia',CE:'Ceará',DF:'Distrito Federal',
  ES:'Espírito Santo',GO:'Goiás',MA:'Maranhão',MT:'Mato Grosso',MS:'Mato Grosso do Sul',
  MG:'Minas Gerais',PA:'Pará',PB:'Paraíba',PR:'Paraná',PE:'Pernambuco',PI:'Piauí',
  RJ:'Rio de Janeiro',RN:'Rio Grande do Norte',RS:'Rio Grande do Sul',RO:'Rondônia',
  RR:'Roraima',SC:'Santa Catarina',SP:'São Paulo',SE:'Sergipe',TO:'Tocantins',
};

const branchStates: Record<string, string> = {
  BALSAS: 'MA',
  IMPERATRIZ: 'MA',
  ITAITINGA: 'CE',
  'SAO LUIS': 'MA',
  TERESINA: 'PI',
  MARITUBA: 'PA',
  MARABA: 'PA',
  MIRITITUBA: 'PA',
  MANAUS: 'AM',
};

type SourceAppointment = {
  id: string;
  branch: string;
  appointment_date: string;
  technician_id: string;
  client_name: string | null;
  equipment_serial: string | null;
  service_city: string | null;
  service_reason: string | null;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type SourceTechnician = {
  id: string;
  branch: string;
  name: string;
  active: boolean;
};

type BranchLocation = {
  branch: string;
  label: string;
  lat: number;
  lng: number;
};

type G4Location = {
  client_name: string | null;
  branch: string | null;
  city: string | null;
  state: string | null;
};

type OverrideLocation = {
  client_name: string | null;
  branch: string | null;
  lat: number;
  lng: number;
};

type MachineSummary = {
  serial: string;
  city: string | null;
  state: string | null;
  branch: string | null;
};

type RouteNode = {
  lat: number;
  lng: number;
  label: string;
  kind: 'branch' | 'appointment' | 'branch_return';
  appointmentId?: string | null;
};

type ResolvedDestination = RouteNode & {
  city: string | null;
  state: string | null;
  source: string;
};

function fold(value?: string | null) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function pair(name?: string | null, branch?: string | null) {
  return `${fold(name)}|${fold(branch)}`;
}

function weekEnd(weekStart: string) {
  const date = new Date(`${weekStart}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 6);
  return date.toISOString().slice(0, 10);
}

function ignoredAppointment(item: SourceAppointment) {
  const reason = fold(item.service_reason);
  return reason === 'SEM AGENDA' || reason === 'FOLGA' || reason === 'FERIAS';
}

function explicitBranchReturn(item: SourceAppointment) {
  const text = fold(`${item.service_reason || ''} ${item.description || ''}`);
  return text.includes('RETORNO') && text.includes('FILIAL');
}

function destinationLabel(item: SourceAppointment) {
  if (explicitBranchReturn(item)) return `Filial ${item.branch}`;
  return String(item.service_city || item.client_name || 'Atendimento').trim();
}

function sortAppointments(a: SourceAppointment, b: SourceAppointment) {
  return a.appointment_date.localeCompare(b.appointment_date)
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || a.id.localeCompare(b.id);
}

function haversineKm(a: RouteNode, b: RouteNode) {
  const rad = (value: number) => value * Math.PI / 180;
  const earth = 6371;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sourceHeaders(sourceKey: string) {
  const headers: Record<string, string> = {
    apikey: sourceKey,
    Accept: 'application/json',
  };
  if (!sourceKey.startsWith('sb_publishable_')) headers.Authorization = `Bearer ${sourceKey}`;
  return headers;
}

async function probeSource(sourceUrl: string, sourceKey: string) {
  try {
    const base = sourceUrl.replace(/\/$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base)) return false;
    const headers = sourceHeaders(sourceKey);
    const [technicians, appointments] = await Promise.all([
      fetch(`${base}/rest/v1/technicians?select=id&limit=1`, { headers }),
      fetch(`${base}/rest/v1/appointments?select=id&limit=1`, { headers }),
    ]);
    return technicians.ok && appointments.ok;
  } catch {
    return false;
  }
}

async function fetchSourceRows(
  sourceUrl: string,
  sourceKey: string,
  table: string,
  select: string,
  filter?: Record<string, string>,
) {
  const rows: any[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL(`${sourceUrl}/rest/v1/${table}`);
    url.searchParams.set('select', select);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    if (filter) for (const [key, value] of Object.entries(filter)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      headers: sourceHeaders(sourceKey),
    });
    if (!response.ok) throw new Error(`source_${table}_http_${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`source_${table}_invalid_payload`);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function inferState(city: string, branch: string, evidence: G4Location[]) {
  const cityKey = fold(city);
  if (!cityKey) return '';
  const sameCity = evidence.filter((row) => fold(row.city) === cityKey && fold(row.state));
  if (!sameCity.length) return '';

  const sameBranch = sameCity.filter((row) => fold(row.branch) === fold(branch));
  const pool = sameBranch.length ? sameBranch : sameCity;
  const counts = new Map<string, number>();
  for (const row of pool) {
    const state = fold(row.state);
    if (state) counts.set(state, (counts.get(state) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 1) return ranked[0][0];
  const first = ranked[0];
  const second = ranked[1];
  if (first && second && first[1] >= 3 && first[1] >= second[1] * 3) return first[0];
  return '';
}

function parseCityState(value?: string | null) {
  const raw = String(value || '').trim();
  if (!raw) return { city: '', state: '' };

  const match = raw.match(/^(.*?)(?:\s*\/\s*|\s+-\s+)([A-Za-z]{2})$/);
  if (!match) return { city: raw, state: '' };

  return {
    city: String(match[1] || '').trim(),
    state: fold(match[2]),
  };
}

function canonicalEvidenceLocation(city: string, branch: string, stateHint: string, evidence: G4Location[]) {
  const cityKey = fold(city);
  const branchKey = fold(branch);
  const stateKey = fold(stateHint);
  if (!cityKey) return null;

  const candidates = evidence.filter((row) => {
    const rowCity = fold(row.city);
    const rowState = fold(row.state);
    const cityMatches = rowCity === cityKey || rowCity.startsWith(`${cityKey} `);
    const branchMatches = !branchKey || fold(row.branch) === branchKey;
    const stateMatches = !stateKey || rowState === stateKey;
    return cityMatches && branchMatches && stateMatches;
  });

  const unique = new Map<string, { city: string; state: string }>();
  for (const row of candidates) {
    const rowCity = String(row.city || '').trim();
    const rowState = fold(row.state);
    if (rowCity && rowState) unique.set(`${fold(rowCity)}|${rowState}`, { city: rowCity, state: rowState });
  }

  if (unique.size === 1) return [...unique.values()][0];

  if (!stateKey && unique.size > 1) {
    const branchState = branchStates[branchKey] || '';
    const regional = [...unique.values()].filter((item) => item.state === branchState);
    if (regional.length === 1) return regional[0];
  }

  return null;
}

async function geocodeCity(db: any, city: string, state: string) {
  const locationKey = `${fold(city)}|${fold(state)}`;
  const { data: cached } = await db
    .from('agenda_route_location_cache')
    .select('city,state,lat,lng,source')
    .eq('location_key', locationKey)
    .maybeSingle();
  if (cached) return { lat: Number(cached.lat), lng: Number(cached.lng), source: String(cached.source || 'cache') };

  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', city);
  url.searchParams.set('count', '20');
  url.searchParams.set('language', 'pt');
  url.searchParams.set('format', 'json');
  url.searchParams.set('countryCode', 'BR');

  const response = await fetch(url);
  if (!response.ok) return null;
  const json = await response.json();
  const desiredCity = fold(city);
  const desiredState = fold(stateNames[fold(state)] || state);
  const chosen = (Array.isArray(json?.results) ? json.results : []).find((item: any) =>
    fold(String(item.name || '')) === desiredCity
    && fold(String(item.admin1 || '')) === desiredState
    && fold(String(item.country_code || '')) === 'BR'
  );
  if (!chosen) return null;

  const row = {
    location_key: locationKey,
    city,
    state: fold(state),
    lat: Number(chosen.latitude),
    lng: Number(chosen.longitude),
    source: 'open-meteo',
    updated_at: new Date().toISOString(),
  };
  await db.from('agenda_route_location_cache').upsert(row);
  return { lat: row.lat, lng: row.lng, source: row.source };
}

async function resolveDestination(
  db: any,
  item: SourceAppointment,
  branchBase: BranchLocation | null,
  overrides: Map<string, OverrideLocation>,
  machines: Map<string, MachineSummary>,
  evidence: G4Location[],
): Promise<ResolvedDestination | null> {
  if (explicitBranchReturn(item)) {
    if (!branchBase) return null;
    return {
      lat: Number(branchBase.lat),
      lng: Number(branchBase.lng),
      label: branchBase.label,
      kind: 'branch_return',
      appointmentId: item.id,
      city: item.branch,
      state: null,
      source: 'branch',
    };
  }

  const official = overrides.get(pair(item.client_name, item.branch));
  if (official && Number.isFinite(Number(official.lat)) && Number.isFinite(Number(official.lng))) {
    return {
      lat: Number(official.lat),
      lng: Number(official.lng),
      label: destinationLabel(item),
      kind: 'appointment',
      appointmentId: item.id,
      city: item.service_city,
      state: null,
      source: 'client_override',
    };
  }

  const machine = item.equipment_serial ? machines.get(fold(item.equipment_serial)) : undefined;
  const entered = parseCityState(item.service_city);
  let city = entered.city || String(machine?.city || '').trim();
  if (!city) return null;

  let state = entered.state;
  const evidenceLocation = canonicalEvidenceLocation(city, item.branch, state, evidence);
  if (evidenceLocation) {
    city = evidenceLocation.city;
    state = state || evidenceLocation.state;
  }

  if (!state && machine?.state && (!machine.city || fold(machine.city) === fold(city))) state = fold(machine.state);
  if (!state) state = inferState(city, item.branch, evidence);
  if (!state) return null;

  const location = await geocodeCity(db, city, state);
  if (!location) return null;

  return {
    lat: location.lat,
    lng: location.lng,
    label: destinationLabel(item),
    kind: 'appointment',
    appointmentId: item.id,
    city,
    state,
    source: location.source,
  };
}

async function routeSegment(db: any, origin: RouteNode, destination: RouteNode) {
  const segmentKey = await sha256(
    `${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}>${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`
  );
  const { data: cached } = await db
    .from('agenda_route_segment_cache')
    .select('distance_km,duration_min,provider')
    .eq('segment_key', segmentKey)
    .maybeSingle();
  if (cached) {
    return {
      segmentKey,
      distanceKm: Number(cached.distance_km),
      durationMin: Number(cached.duration_min),
      provider: String(cached.provider || 'cache'),
    };
  }

  if (haversineKm(origin, destination) < 0.05) {
    const row = {
      segment_key: segmentKey,
      origin_label: origin.label,
      destination_label: destination.label,
      origin_lat: origin.lat,
      origin_lng: origin.lng,
      destination_lat: destination.lat,
      destination_lng: destination.lng,
      distance_km: 0,
      duration_min: 0,
      provider: 'same-point',
      updated_at: new Date().toISOString(),
    };
    await db.from('agenda_route_segment_cache').upsert(row);
    return { segmentKey, distanceKm: 0, durationMin: 0, provider: 'same-point' };
  }

  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  let lastError: unknown = null;

  for (const router of ROUTERS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(
          `${router.base}/route/v1/driving/${coords}?overview=false&steps=false`,
          { signal: controller.signal, headers: { 'User-Agent': 'AgendaTecnicaRouteWorker/1.0' } },
        );
        if (!response.ok) throw new Error(`route_http_${response.status}`);
        const json = await response.json();
        const best = json?.routes?.[0];
        if (!best) throw new Error('route_missing');
        const distanceKm = Math.round((Number(best.distance || 0) / 1000) * 10) / 10;
        const durationMin = Math.round(Number(best.duration || 0) / 60);
        const row = {
          segment_key: segmentKey,
          origin_label: origin.label,
          destination_label: destination.label,
          origin_lat: origin.lat,
          origin_lng: origin.lng,
          destination_lat: destination.lat,
          destination_lng: destination.lng,
          distance_km: distanceKm,
          duration_min: durationMin,
          provider: router.name,
          updated_at: new Date().toISOString(),
        };
        await db.from('agenda_route_segment_cache').upsert(row);
        clearTimeout(timeout);
        return { segmentKey, distanceKm, durationMin, provider: router.name };
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('route_unavailable');
}

async function processJob(
  db: any,
  job: { technician_id: string; week_start: string; lock_token: string },
  branches: Map<string, BranchLocation>,
  technicians: Map<string, SourceTechnician>,
  overrides: Map<string, OverrideLocation>,
  evidence: G4Location[],
) {
  const { data: rows, error } = await db
    .from('agenda_route_source_appointments')
    .select('*')
    .eq('technician_id', job.technician_id)
    .gte('appointment_date', job.week_start)
    .lte('appointment_date', weekEnd(job.week_start))
    .order('appointment_date')
    .order('created_at');

  if (error) throw error;
  const appointments = ((rows || []) as SourceAppointment[]).slice().sort(sortAppointments);
  const technician = technicians.get(job.technician_id);
  const branchName = fold(appointments[0]?.branch || technician?.branch || '');
  const branchBase = branches.get(branchName) || null;

  const serials = Array.from(new Set(appointments.map((item) => fold(item.equipment_serial)).filter(Boolean)));
  const machines = new Map<string, MachineSummary>();
  for (let index = 0; index < serials.length; index += 100) {
    const batch = serials.slice(index, index + 100);
    const { data } = await db
      .from('g4_machine_summary')
      .select('serial,city,state,branch')
      .in('serial', batch);
    for (const item of (data || []) as MachineSummary[]) machines.set(fold(item.serial), item);
  }

  const metrics: any[] = [];
  let current: RouteNode | null = branchBase
    ? { lat: Number(branchBase.lat), lng: Number(branchBase.lng), label: branchBase.label, kind: 'branch' }
    : null;
  let currentAppointmentId: string | null = null;

  for (const item of appointments) {
    if (ignoredAppointment(item)) {
      metrics.push({
        appointment_id: item.id,
        technician_id: item.technician_id,
        appointment_date: item.appointment_date,
        week_start: job.week_start,
        origin_kind: current?.kind || 'unknown',
        origin_appointment_id: currentAppointmentId,
        origin_label: current?.label || null,
        destination_label: destinationLabel(item),
        destination_city: item.service_city,
        destination_state: null,
        distance_km: null,
        duration_min: null,
        status: 'ignored',
        provider: null,
        segment_key: null,
        calculated_at: new Date().toISOString(),
        source_updated_at: item.updated_at,
        metadata: { reason: item.service_reason || 'ignored' },
      });
      continue;
    }

    const destination = await resolveDestination(db, item, branchBase, overrides, machines, evidence);
    if (!destination) {
      metrics.push({
        appointment_id: item.id,
        technician_id: item.technician_id,
        appointment_date: item.appointment_date,
        week_start: job.week_start,
        origin_kind: current?.kind || 'unknown',
        origin_appointment_id: currentAppointmentId,
        origin_label: current?.label || null,
        destination_label: destinationLabel(item),
        destination_city: item.service_city,
        destination_state: null,
        distance_km: null,
        duration_min: null,
        status: 'location_missing',
        provider: null,
        segment_key: null,
        calculated_at: new Date().toISOString(),
        source_updated_at: item.updated_at,
        metadata: { reason: 'city_or_state_unresolved' },
      });
      current = null;
      currentAppointmentId = item.id;
      continue;
    }

    if (!current) {
      metrics.push({
        appointment_id: item.id,
        technician_id: item.technician_id,
        appointment_date: item.appointment_date,
        week_start: job.week_start,
        origin_kind: 'unknown',
        origin_appointment_id: currentAppointmentId,
        origin_label: 'Local anterior não identificado',
        destination_label: destination.label,
        destination_city: destination.city,
        destination_state: destination.state,
        distance_km: null,
        duration_min: null,
        status: 'location_missing',
        provider: null,
        segment_key: null,
        calculated_at: new Date().toISOString(),
        source_updated_at: item.updated_at,
        metadata: { destination_source: destination.source, reason: 'origin_unresolved' },
      });
      current = destination;
      currentAppointmentId = item.id;
      continue;
    }

    try {
      const route = await routeSegment(db, current, destination);
      metrics.push({
        appointment_id: item.id,
        technician_id: item.technician_id,
        appointment_date: item.appointment_date,
        week_start: job.week_start,
        origin_kind: current.kind,
        origin_appointment_id: currentAppointmentId,
        origin_label: current.label,
        destination_label: destination.label,
        destination_city: destination.city,
        destination_state: destination.state,
        distance_km: route.distanceKm,
        duration_min: route.durationMin,
        status: 'ready',
        provider: route.provider,
        segment_key: route.segmentKey,
        calculated_at: new Date().toISOString(),
        source_updated_at: item.updated_at,
        metadata: { destination_source: destination.source },
      });
    } catch (routeError) {
      metrics.push({
        appointment_id: item.id,
        technician_id: item.technician_id,
        appointment_date: item.appointment_date,
        week_start: job.week_start,
        origin_kind: current.kind,
        origin_appointment_id: currentAppointmentId,
        origin_label: current.label,
        destination_label: destination.label,
        destination_city: destination.city,
        destination_state: destination.state,
        distance_km: null,
        duration_min: null,
        status: 'route_unavailable',
        provider: null,
        segment_key: null,
        calculated_at: new Date().toISOString(),
        source_updated_at: item.updated_at,
        metadata: { error: routeError instanceof Error ? routeError.message : 'route_unavailable' },
      });
    }

    current = destination;
    currentAppointmentId = item.id;
  }

  if (metrics.length) {
    const { error: metricError } = await db.from('agenda_route_metrics').upsert(metrics);
    if (metricError) throw metricError;
  }

  const { error: deleteError } = await db
    .from('agenda_route_recalc_queue')
    .delete()
    .eq('technician_id', job.technician_id)
    .eq('week_start', job.week_start)
    .eq('lock_token', job.lock_token);
  if (deleteError) throw deleteError;
}

async function syncSource(db: any, mode: string) {
  const { data: sourceConfigRow } = await db
    .from('agenda_route_sync_state')
    .select('value')
    .eq('key', 'source_supabase')
    .maybeSingle();
  const sourceUrl = String(sourceConfigRow?.value?.url || '').replace(/\/$/, '');
  const sourceKey = String(sourceConfigRow?.value?.anon_key || '');
  if (!sourceUrl || !sourceKey || !(await probeSource(sourceUrl, sourceKey))) {
    return { waiting_source_registration: true, full: false, appointments: 0, technicians: 0 };
  }

  const { data: syncRow } = await db
    .from('agenda_route_sync_state')
    .select('value')
    .eq('key', 'appointments_source')
    .maybeSingle();

  const previous = syncRow?.value || {};
  const lastSync = String(previous.last_sync_at || '');
  const lastFull = String(previous.last_full_sync_at || '');
  const fullDue = !lastFull || (Date.now() - new Date(lastFull).getTime()) > FULL_SYNC_HOURS * 3600000;
  const full = mode === 'full' || !lastSync || fullDue;
  const runStarted = new Date();
  const runStartedIso = runStarted.toISOString();

  const technicians = await fetchSourceRows(
    sourceUrl,
    sourceKey,
    'technicians',
    'id,branch,name,active',
  ) as SourceTechnician[];
  if (technicians.length) {
    const rows = technicians.map((item) => ({ ...item, source_seen_at: runStartedIso }));
    const { error } = await db.from('agenda_route_source_technicians').upsert(rows);
    if (error) throw error;
  }

  const filter: Record<string, string> = {};
  if (!full && lastSync) {
    const overlap = new Date(new Date(lastSync).getTime() - 120000).toISOString();
    filter.updated_at = `gt.${overlap}`;
  }

  const appointments = await fetchSourceRows(
    sourceUrl,
    sourceKey,
    'appointments',
    'id,branch,appointment_date,technician_id,client_name,equipment_serial,service_city,service_reason,description,created_at,updated_at',
    filter,
  ) as SourceAppointment[];

  for (let index = 0; index < appointments.length; index += 400) {
    const rows = appointments.slice(index, index + 400).map((item) => ({ ...item, source_seen_at: runStartedIso }));
    const { error } = await db.from('agenda_route_source_appointments').upsert(rows);
    if (error) throw error;
  }

  if (full) {
    const { error } = await db
      .from('agenda_route_source_appointments')
      .delete()
      .lt('source_seen_at', runStartedIso);
    if (error) throw error;
  }

  const nextState = {
    last_sync_at: runStartedIso,
    last_full_sync_at: full ? runStartedIso : lastFull || null,
    rows_seen: appointments.length,
    full,
  };
  await db.from('agenda_route_sync_state').upsert({
    key: 'appointments_source',
    value: nextState,
    updated_at: new Date().toISOString(),
  });

  return { full, appointments: appointments.length, technicians: technicians.length };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  try {
    const body = await req.json().catch(() => ({}));

    if (String(body?.mode || '') === 'register_source') {
      const sourceUrl = String(body?.source_url || '').replace(/\/$/, '');
      const sourceKey = String(body?.source_key || '');
      if (!sourceUrl || !sourceKey || !(await probeSource(sourceUrl, sourceKey))) {
        return new Response(JSON.stringify({ error: 'invalid_source' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: current } = await db
        .from('agenda_route_sync_state')
        .select('value')
        .eq('key', 'source_supabase')
        .maybeSingle();

      const currentUrl = String(current?.value?.url || '').replace(/\/$/, '');
      const currentKey = String(current?.value?.anon_key || '');
      const currentValid = Boolean(currentUrl && currentKey && await probeSource(currentUrl, currentKey));

      if (!currentValid) {
        await db.from('agenda_route_sync_state').upsert({
          key: 'source_supabase',
          value: { url: sourceUrl, anon_key: sourceKey },
          updated_at: new Date().toISOString(),
        });
        await db.from('agenda_route_sync_state').delete().eq('key', 'appointments_source');
      }

      return new Response(JSON.stringify({ ok: true, registered: !currentValid }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    const { data: secretRow, error: secretError } = await db
      .from('agenda_route_sync_state')
      .select('value')
      .eq('key', 'worker_secret')
      .single();
    if (secretError) throw secretError;

    const expectedSecret = String(secretRow?.value?.secret || '');
    if (!expectedSecret || String(body?.worker_secret || '') !== expectedSecret) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const sync = await syncSource(db, String(body?.mode || 'scheduled'));

    const { data: jobs, error: jobsError } = await db.rpc('claim_agenda_route_jobs', { p_limit: JOB_LIMIT });
    if (jobsError) throw jobsError;

    if (!(jobs || []).length) {
      const { count: queueRemaining } = await db
        .from('agenda_route_recalc_queue')
        .select('*', { count: 'exact', head: true });
      return new Response(JSON.stringify({
        ok: true,
        sync,
        processed: 0,
        failed: 0,
        queue_remaining: queueRemaining || 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    const [{ data: branchRows }, { data: technicianRows }, { data: overrideRows }, { data: evidenceRows }] = await Promise.all([
      db.from('agenda_route_branch_locations').select('branch,label,lat,lng'),
      db.from('agenda_route_source_technicians').select('id,branch,name,active'),
      db.from('client_location_overrides').select('client_name,branch,lat,lng').limit(10000),
      db.from('g4_client_location_summary').select('client_name,branch,city,state').not('city', 'is', null).not('state', 'is', null).limit(10000),
    ]);

    const branches = new Map<string, BranchLocation>();
    for (const row of (branchRows || []) as BranchLocation[]) branches.set(fold(row.branch), row);

    const technicians = new Map<string, SourceTechnician>();
    for (const row of (technicianRows || []) as SourceTechnician[]) technicians.set(row.id, row);

    const overrides = new Map<string, OverrideLocation>();
    for (const row of (overrideRows || []) as OverrideLocation[]) {
      if (row.client_name && row.branch) overrides.set(pair(row.client_name, row.branch), row);
    }

    const evidence = (evidenceRows || []) as G4Location[];

    let processed = 0;
    let failed = 0;
    for (const job of jobs || []) {
      try {
        await processJob(db, job, branches, technicians, overrides, evidence);
        processed += 1;
      } catch (jobError) {
        failed += 1;
        await db
          .from('agenda_route_recalc_queue')
          .update({
            locked_at: null,
            lock_token: null,
            last_error: jobError instanceof Error ? jobError.message : 'job_failed',
          })
          .eq('technician_id', job.technician_id)
          .eq('week_start', job.week_start)
          .eq('lock_token', job.lock_token);
      }
    }

    const { count: queueRemaining } = await db
      .from('agenda_route_recalc_queue')
      .select('*', { count: 'exact', head: true });

    return new Response(JSON.stringify({
      ok: true,
      sync,
      processed,
      failed,
      queue_remaining: queueRemaining || 0,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'agenda_route_worker_failed',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
