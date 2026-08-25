import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const USER_AGENT = 'AgendaTecnicaRetencao/2.0 (+https://controle-agenda.vercel.app)';
const PAGE_SIZE = 1000;
const EXACT_GEOCODE_LIMIT = 12;
const CITY_CONCURRENCY = 10;
const ROUTE_RADIUS_KM = 30;

const stateNames: Record<string, string> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
  PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

type ClientInput = {
  client_key: string;
  client_name: string;
  branch: string;
  city?: string | null;
  last_service_at?: string | null;
};

type AppointmentInput = {
  id: string;
  branch: string;
  appointment_date: string;
  technician_id: string;
  technician_name?: string | null;
  client_name?: string | null;
  equipment_serial?: string | null;
  service_city?: string | null;
};

type ClientLocation = {
  client_key: string;
  client_name: string;
  branch: string;
  address: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
};

type Candidate = {
  id: string;
  kind: 'branch' | 'appointment' | 'client';
  exactQuery?: string;
  cityQuery?: string;
  cityName?: string;
  state?: string;
  payload: Record<string, unknown>;
};

type CachedLocation = {
  cache_key: string;
  query: string;
  lat: number;
  lng: number;
  display_name: string | null;
  precision: string | null;
  source: string | null;
};

function normalize(value: string) {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function fold(value: string) {
  return normalize(value).normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function buildExactQuery(location?: ClientLocation, fallbackCity?: string | null) {
  if (!location?.address) return '';
  return [location.address, location.neighborhood, location.city || fallbackCity, location.state, 'Brasil']
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ');
}

function buildCityQuery(city?: string | null, state?: string | null) {
  const cleanCity = String(city || '').trim();
  if (!cleanCity) return '';
  return [cleanCity, String(state || '').trim(), 'Brasil'].filter(Boolean).join(', ');
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalize(value)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function offsetCityPoint(lat: number, lng: number, key: string) {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  const angle = (Math.abs(hash) % 360) * Math.PI / 180;
  const ring = 0.003 + ((Math.abs(hash >> 8) % 7) * 0.0012);
  const latOffset = Math.sin(angle) * ring;
  const lngOffset = Math.cos(angle) * ring / Math.max(0.35, Math.cos(lat * Math.PI / 180));
  return { lat: lat + latOffset, lng: lng + lngOffset };
}

function haversineKm(a: [number, number], b: [number, number]) {
  const toRad = (value: number) => value * Math.PI / 180;
  const earth = 6371;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

function distanceToRouteKm(point: [number, number], geometry: [number, number][]) {
  if (!geometry.length) return Number.POSITIVE_INFINITY;
  const step = Math.max(1, Math.floor(geometry.length / 280));
  let min = Number.POSITIVE_INFINITY;
  for (let index = 0; index < geometry.length; index += step) {
    min = Math.min(min, haversineKm(point, geometry[index]));
    if (min <= 1) return min;
  }
  min = Math.min(min, haversineKm(point, geometry[geometry.length - 1]));
  return min;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const clients = (Array.isArray(body.clients) ? body.clients : []) as ClientInput[];
    const appointments = (Array.isArray(body.appointments) ? body.appointments : []) as AppointmentInput[];
    const selectedTechnicianId = typeof body.technician_id === 'string' ? body.technician_id : '';

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const branches = Array.from(new Set([...clients.map((client) => client.branch), ...appointments.map((item) => item.branch)].filter(Boolean)));

    const locationRows: ClientLocation[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = supabase
        .from('g4_client_location_summary')
        .select('client_key,client_name,branch,address,neighborhood,city,state')
        .range(from, from + PAGE_SIZE - 1);
      if (branches.length) query = query.in('branch', branches);
      const { data, error } = await query;
      if (error) throw error;
      const page = (data || []) as ClientLocation[];
      locationRows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const locationByKey = new Map(locationRows.map((row) => [row.client_key, row]));
    const locationByClientBranch = new Map(locationRows.map((row) => [`${normalize(row.client_name)}|${normalize(row.branch)}`, row]));

    const selectedAppointments = appointments
      .filter((item) => !selectedTechnicianId || item.technician_id === selectedTechnicianId)
      .sort((a, b) => a.appointment_date.localeCompare(b.appointment_date) || a.id.localeCompare(b.id));
    const selectedBranch = selectedAppointments[0]?.branch || '';

    let branchAddress = '';
    if (selectedBranch) {
      const { data } = await supabase.from('app_branches').select('address').eq('name', selectedBranch).maybeSingle();
      branchAddress = String(data?.address || '').trim();
    }

    const candidates: Candidate[] = [];

    if (selectedBranch) {
      candidates.push({
        id: `branch:${selectedBranch}`,
        kind: 'branch',
        exactQuery: branchAddress || undefined,
        cityQuery: buildCityQuery(selectedBranch, null),
        cityName: selectedBranch,
        payload: { branch: selectedBranch, name: `Tracbel ${selectedBranch}` },
      });
    }

    for (const appointment of appointments) {
      const location = appointment.client_name
        ? locationByClientBranch.get(`${normalize(appointment.client_name)}|${normalize(appointment.branch)}`)
        : undefined;
      const city = appointment.service_city || location?.city || '';
      candidates.push({
        id: `appointment:${appointment.id}`,
        kind: 'appointment',
        exactQuery: buildExactQuery(location, city) || undefined,
        cityQuery: buildCityQuery(city, location?.state) || undefined,
        cityName: city || undefined,
        state: location?.state || undefined,
        payload: { ...appointment },
      });
    }

    for (const client of clients) {
      const location = locationByKey.get(client.client_key);
      const city = location?.city || client.city || '';
      candidates.push({
        id: `client:${client.client_key}`,
        kind: 'client',
        exactQuery: buildExactQuery(location, city) || undefined,
        cityQuery: buildCityQuery(city, location?.state) || undefined,
        cityName: city || undefined,
        state: location?.state || undefined,
        payload: { ...client },
      });
    }

    const allQueries = Array.from(new Set(candidates.flatMap((candidate) => [candidate.exactQuery, candidate.cityQuery]).filter(Boolean) as string[]));
    const keyPairs = await Promise.all(allQueries.map(async (query) => [query, await sha256(query)] as const));
    const queryKey = new Map(keyPairs);
    const cached = new Map<string, CachedLocation>();
    const cacheKeys = keyPairs.map(([, key]) => key);

    for (let start = 0; start < cacheKeys.length; start += 200) {
      const chunk = cacheKeys.slice(start, start + 200);
      const { data, error } = await supabase
        .from('map_location_cache')
        .select('cache_key,query,lat,lng,display_name,precision,source')
        .in('cache_key', chunk);
      if (error) throw error;
      for (const row of data || []) cached.set(row.cache_key, row as CachedLocation);
    }

    let geocodedNow = 0;

    async function cacheLocation(query: string, lat: number, lng: number, displayName: string, precision: string, source: string) {
      const key = queryKey.get(query) || await sha256(query);
      const row = { cache_key: key, query, lat, lng, display_name: displayName, precision, source };
      await supabase.from('map_location_cache').upsert({ ...row, updated_at: new Date().toISOString() });
      cached.set(key, row);
      geocodedNow += 1;
      return row;
    }

    async function geocodeCity(candidate: Candidate) {
      if (!candidate.cityQuery || !candidate.cityName) return null;
      const key = queryKey.get(candidate.cityQuery) || await sha256(candidate.cityQuery);
      const hit = cached.get(key);
      if (hit) return hit;

      try {
        const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
        url.searchParams.set('name', candidate.cityName);
        url.searchParams.set('count', '10');
        url.searchParams.set('language', 'pt');
        url.searchParams.set('format', 'json');
        url.searchParams.set('countryCode', 'BR');
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (!response.ok) return null;
        const json = await response.json();
        const rows = Array.isArray(json?.results) ? json.results : [];
        if (!rows.length) return null;
        const desiredState = stateNames[normalize(candidate.state || '')] || candidate.state || '';
        const desiredFolded = fold(desiredState);
        const chosen = rows.find((row: any) => desiredFolded && fold(String(row.admin1 || '')) === desiredFolded)
          || rows.find((row: any) => String(row.country_code || '').toUpperCase() === 'BR')
          || rows[0];
        if (!Number.isFinite(Number(chosen.latitude)) || !Number.isFinite(Number(chosen.longitude))) return null;
        return await cacheLocation(
          candidate.cityQuery,
          Number(chosen.latitude),
          Number(chosen.longitude),
          String(chosen.name || candidate.cityQuery),
          'city',
          'open-meteo',
        );
      } catch {
        return null;
      }
    }

    const cityRepresentative = new Map<string, Candidate>();
    for (const candidate of candidates) {
      if (!candidate.cityQuery) continue;
      const key = queryKey.get(candidate.cityQuery) || await sha256(candidate.cityQuery);
      if (!cached.has(key) && !cityRepresentative.has(candidate.cityQuery)) cityRepresentative.set(candidate.cityQuery, candidate);
    }

    const citiesToResolve = Array.from(cityRepresentative.values());
    for (let start = 0; start < citiesToResolve.length; start += CITY_CONCURRENCY) {
      await Promise.all(citiesToResolve.slice(start, start + CITY_CONCURRENCY).map((candidate) => geocodeCity(candidate)));
    }

    let exactCalls = 0;
    async function geocodeExact(candidate: Candidate) {
      if (!candidate.exactQuery || exactCalls >= EXACT_GEOCODE_LIMIT) return null;
      const key = queryKey.get(candidate.exactQuery) || await sha256(candidate.exactQuery);
      const hit = cached.get(key);
      if (hit) return hit;
      if (candidate.kind === 'client') return null;

      if (exactCalls > 0) await sleep(1050);
      exactCalls += 1;
      try {
        const url = new URL('https://nominatim.openstreetmap.org/search');
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('limit', '1');
        url.searchParams.set('countrycodes', 'br');
        url.searchParams.set('q', candidate.exactQuery);
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9' } });
        if (!response.ok) return null;
        const rows = await response.json();
        if (!Array.isArray(rows) || !rows[0]) return null;
        return await cacheLocation(candidate.exactQuery, Number(rows[0].lat), Number(rows[0].lon), String(rows[0].display_name || candidate.exactQuery), 'address', 'nominatim');
      } catch {
        return null;
      }
    }

    const points: any[] = [];
    for (const candidate of candidates) {
      let location: CachedLocation | null = null;
      if (candidate.exactQuery) {
        const exactKey = queryKey.get(candidate.exactQuery) || await sha256(candidate.exactQuery);
        location = cached.get(exactKey) || null;
        if (!location && candidate.kind !== 'client') location = await geocodeExact(candidate);
      }
      if (!location && candidate.cityQuery) {
        const cityKey = queryKey.get(candidate.cityQuery) || await sha256(candidate.cityQuery);
        location = cached.get(cityKey) || null;
      }
      if (!location) continue;

      let lat = Number(location.lat);
      let lng = Number(location.lng);
      if (candidate.kind === 'client' && location.precision === 'city') {
        const offset = offsetCityPoint(lat, lng, candidate.id);
        lat = offset.lat;
        lng = offset.lng;
      }

      points.push({
        id: candidate.id,
        kind: candidate.kind,
        lat,
        lng,
        precision: location.precision || 'city',
        ...candidate.payload,
      });
    }

    let route: any = null;
    if (selectedTechnicianId) {
      const orderedStops = selectedAppointments
        .map((appointment) => points.find((point) => point.kind === 'appointment' && point.id === `appointment:${appointment.id}`))
        .filter(Boolean);
      const branchPoint = points.find((point) => point.kind === 'branch' && point.branch === selectedBranch);
      const routePoints = [branchPoint, ...orderedStops].filter(Boolean);

      if (routePoints.length >= 2) {
        const coords = routePoints.map((point) => `${point.lng},${point.lat}`).join(';');
        try {
          const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`, { headers: { 'User-Agent': USER_AGENT } });
          const json = await response.json();
          const geometry = json?.routes?.[0]?.geometry?.coordinates;
          if (response.ok && Array.isArray(geometry)) {
            route = {
              technician_id: selectedTechnicianId,
              approximate: false,
              origin_label: `Tracbel ${selectedBranch}`,
              geometry: geometry.map((pair: number[]) => [pair[1], pair[0]]),
            };
          }
        } catch {
          // fallback below
        }

        if (!route) {
          route = {
            technician_id: selectedTechnicianId,
            approximate: true,
            origin_label: `Tracbel ${selectedBranch}`,
            geometry: routePoints.map((point) => [point.lat, point.lng]),
          };
        }

        let nearbyClients = 0;
        for (const point of points) {
          if (point.kind !== 'client') continue;
          const distance = distanceToRouteKm([point.lat, point.lng], route.geometry);
          point.route_distance_km = Math.round(distance * 10) / 10;
          point.near_route = distance <= ROUTE_RADIUS_KM;
          if (point.near_route) nearbyClients += 1;
        }
        route.nearby_clients = nearbyClients;
        route.radius_km = ROUTE_RADIUS_KM;
      }
    }

    const clientPoints = points.filter((point) => point.kind === 'client');
    const unresolved = Math.max(0, clients.length - clientPoints.length);

    return new Response(JSON.stringify({
      points,
      route,
      unresolved,
      geocoded_now: geocodedNow,
      exact_external_calls: exactCalls,
      requested_clients: clients.length,
      located_clients: clientPoints.length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'map_context_failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
