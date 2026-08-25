import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const USER_AGENT = 'AgendaTecnicaRetencao/4.0 (+https://controle-agenda-six.vercel.app)';
const PAGE_SIZE = 1000;
const EXACT_GEOCODE_LIMIT = 8;
const CITY_CONCURRENCY = 8;
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

type EnrichedLocation = {
  client_key: string;
  client_name: string;
  branch: string;
  city: string | null;
  state: string | null;
  address: string | null;
  neighborhood: string | null;
  lat: number | null;
  lng: number | null;
  precision: string | null;
  source: string | null;
  matched_name: string | null;
  confidence: number | null;
  status: string;
};

type DirectLocation = {
  lat: number;
  lng: number;
  precision: string;
  source: string;
  display_name: string | null;
};

type Candidate = {
  id: string;
  kind: 'branch' | 'appointment' | 'client';
  exactQuery?: string;
  cityQuery?: string;
  cityName?: string;
  state?: string;
  direct?: DirectLocation;
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

function fold(value?: string | null) {
  return normalize(String(value || '')).normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function sameCity(a?: string | null, b?: string | null) {
  return Boolean(a && b && fold(a) === fold(b));
}

function sameState(a?: string | null, b?: string | null) {
  if (!a || !b) return true;
  const aa = fold(a);
  const bb = fold(b);
  const aName = fold(stateNames[normalize(a)] || a);
  const bName = fold(stateNames[normalize(b)] || b);
  return aa === bb || aName === bName;
}

function buildExactQuery(address?: string | null, neighborhood?: string | null, city?: string | null, state?: string | null) {
  if (!String(address || '').trim()) return '';
  return [address, neighborhood, city, state, 'Brasil']
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ');
}

function buildCityQuery(city?: string | null, state?: string | null) {
  const cleanCity = String(city || '').trim();
  if (!cleanCity || !String(state || '').trim()) return '';
  return [cleanCity, String(state || '').trim(), 'Brasil'].join(', ');
}

function parseStateFromAddress(address: string) {
  const match = address.toUpperCase().match(/-\s*([A-Z]{2})(?:,|\s+BRASIL)/);
  return match?.[1] || '';
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalize(value)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  return Math.min(min, haversineKm(point, geometry[geometry.length - 1]));
}

function nominatimCityMatches(address: Record<string, unknown> | undefined, targetCity?: string | null) {
  if (!targetCity) return true;
  const values = [
    address?.city,
    address?.town,
    address?.village,
    address?.municipality,
    address?.county,
    address?.city_district,
  ].map((value) => fold(String(value || ''))).filter(Boolean);
  const wanted = fold(targetCity);
  return values.some((value) => value === wanted || value.includes(wanted) || wanted.includes(value));
}

function nominatimStateMatches(address: Record<string, unknown> | undefined, targetState?: string | null) {
  if (!targetState) return true;
  const wantedCode = normalize(targetState);
  const wantedName = fold(stateNames[wantedCode] || targetState);
  const state = fold(String(address?.state || ''));
  const iso = normalize(String(address?.['ISO3166-2-lvl4'] || address?.['ISO3166-2-lvl3'] || ''));
  return state === wantedName || iso.endsWith(`-${wantedCode}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const clients = (Array.isArray(body.clients) ? body.clients : []) as ClientInput[];
    const appointments = (Array.isArray(body.appointments) ? body.appointments : []) as AppointmentInput[];
    const selectedTechnicianId = typeof body.technician_id === 'string' ? body.technician_id : '';

    const db = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const branches = Array.from(new Set([
      ...clients.map((client) => client.branch),
      ...appointments.map((item) => item.branch),
    ].filter(Boolean)));

    const locationRows: ClientLocation[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = db
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
    const locationByClientBranch = new Map(locationRows.map((row) => [
      `${normalize(row.client_name)}|${normalize(row.branch)}`,
      row,
    ]));

    const enrichmentRows: EnrichedLocation[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = db
        .from('client_address_enrichment')
        .select('client_key,client_name,branch,city,state,address,neighborhood,lat,lng,precision,source,matched_name,confidence,status')
        .range(from, from + PAGE_SIZE - 1);
      if (branches.length) query = query.in('branch', branches);
      const { data, error } = await query;
      if (error) throw error;
      const page = (data || []) as EnrichedLocation[];
      enrichmentRows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const enrichmentByKey = new Map(enrichmentRows.map((row) => [row.client_key, row]));
    const enrichmentByClientBranch = new Map(enrichmentRows.map((row) => [
      `${normalize(row.client_name)}|${normalize(row.branch)}`,
      row,
    ]));

    function directFrom(enriched: EnrichedLocation | undefined, city: string, state: string) {
      if (!enriched || enriched.status !== 'found') return undefined;
      if (!Number.isFinite(Number(enriched.lat)) || !Number.isFinite(Number(enriched.lng))) return undefined;
      if ((enriched.precision || '').toLowerCase() === 'city') return undefined;
      if (city && enriched.city && !sameCity(enriched.city, city)) return undefined;
      if (state && enriched.state && !sameState(enriched.state, state)) return undefined;
      return {
        lat: Number(enriched.lat),
        lng: Number(enriched.lng),
        precision: enriched.precision || 'address',
        source: enriched.source || 'enrichment',
        display_name: enriched.address || enriched.matched_name || enriched.client_name,
      } as DirectLocation;
    }

    const selectedAppointments = appointments
      .filter((item) => !selectedTechnicianId || item.technician_id === selectedTechnicianId)
      .sort((a, b) => a.appointment_date.localeCompare(b.appointment_date) || a.id.localeCompare(b.id));
    const selectedBranch = selectedAppointments[0]?.branch || '';

    let branchAddress = '';
    let branchState = '';
    if (selectedBranch) {
      const { data } = await db.from('app_branches').select('address').eq('name', selectedBranch).maybeSingle();
      branchAddress = String(data?.address || '').trim();
      branchState = parseStateFromAddress(branchAddress);
    }

    const candidates: Candidate[] = [];

    if (selectedBranch) {
      candidates.push({
        id: `branch:${selectedBranch}`,
        kind: 'branch',
        exactQuery: branchAddress || undefined,
        cityQuery: buildCityQuery(selectedBranch, branchState) || undefined,
        cityName: selectedBranch,
        state: branchState || undefined,
        payload: { branch: selectedBranch, name: `Tracbel ${selectedBranch}`, city: selectedBranch, state: branchState || null },
      });
    }

    for (const appointment of appointments) {
      const lookupKey = appointment.client_name
        ? `${normalize(appointment.client_name)}|${normalize(appointment.branch)}`
        : '';
      const base = lookupKey ? locationByClientBranch.get(lookupKey) : undefined;
      const enriched = lookupKey ? enrichmentByClientBranch.get(lookupKey) : undefined;
      const city = String(appointment.service_city || base?.city || enriched?.city || '').trim();
      const state = String(base?.state || enriched?.state || '').trim();
      const address = base?.address || enriched?.address || null;
      const neighborhood = base?.neighborhood || enriched?.neighborhood || null;

      candidates.push({
        id: `appointment:${appointment.id}`,
        kind: 'appointment',
        exactQuery: buildExactQuery(address, neighborhood, city, state) || undefined,
        cityQuery: buildCityQuery(city, state) || undefined,
        cityName: city || undefined,
        state: state || undefined,
        direct: directFrom(enriched, city, state),
        payload: { ...appointment, city: city || null, state: state || null },
      });
    }

    for (const client of clients) {
      const lookupKey = `${normalize(client.client_name)}|${normalize(client.branch)}`;
      const base = locationByKey.get(client.client_key) || locationByClientBranch.get(lookupKey);
      const enriched = enrichmentByKey.get(client.client_key) || enrichmentByClientBranch.get(lookupKey);
      const city = String(client.city || base?.city || enriched?.city || '').trim();
      const state = String(base?.state || enriched?.state || '').trim();
      const address = base?.address || enriched?.address || null;
      const neighborhood = base?.neighborhood || enriched?.neighborhood || null;

      candidates.push({
        id: `client:${client.client_key}`,
        kind: 'client',
        exactQuery: buildExactQuery(address, neighborhood, city, state) || undefined,
        cityQuery: buildCityQuery(city, state) || undefined,
        cityName: city || undefined,
        state: state || undefined,
        direct: directFrom(enriched, city, state),
        payload: { ...client, city: city || null, state: state || null },
      });
    }

    const allQueries = Array.from(new Set(
      candidates.flatMap((candidate) => [candidate.exactQuery, candidate.cityQuery]).filter(Boolean) as string[],
    ));
    const pairs = await Promise.all(allQueries.map(async (query) => [query, await sha256(query)] as const));
    const queryKey = new Map(pairs);
    const cached = new Map<string, CachedLocation>();
    const cacheKeys = pairs.map(([, key]) => key);

    for (let start = 0; start < cacheKeys.length; start += 200) {
      const chunk = cacheKeys.slice(start, start + 200);
      const { data, error } = await db
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
      await db.from('map_location_cache').upsert({ ...row, updated_at: new Date().toISOString() });
      cached.set(key, row);
      geocodedNow += 1;
      return row;
    }

    async function geocodeCity(candidate: Candidate) {
      if (!candidate.cityQuery || !candidate.cityName || !candidate.state) return null;
      const key = queryKey.get(candidate.cityQuery) || await sha256(candidate.cityQuery);
      const hit = cached.get(key);
      if (hit && hit.precision === 'city') return hit;

      try {
        const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
        url.searchParams.set('name', candidate.cityName);
        url.searchParams.set('count', '20');
        url.searchParams.set('language', 'pt');
        url.searchParams.set('format', 'json');
        url.searchParams.set('countryCode', 'BR');
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (!response.ok) return null;
        const json = await response.json();
        const rows = Array.isArray(json?.results) ? json.results : [];
        const desiredState = fold(stateNames[normalize(candidate.state)] || candidate.state);
        const desiredCity = fold(candidate.cityName);
        const chosen = rows.find((row: any) =>
          fold(String(row.name || '')) === desiredCity &&
          fold(String(row.admin1 || '')) === desiredState &&
          String(row.country_code || '').toUpperCase() === 'BR'
        );
        if (!chosen) return null;
        const lat = Number(chosen.latitude);
        const lng = Number(chosen.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return await cacheLocation(
          candidate.cityQuery,
          lat,
          lng,
          `${chosen.name}, ${chosen.admin1}`,
          'city',
          'open-meteo',
        );
      } catch {
        return null;
      }
    }

    const cityRepresentative = new Map<string, Candidate>();
    for (const candidate of candidates) {
      if (candidate.direct || !candidate.cityQuery || !candidate.state) continue;
      const key = queryKey.get(candidate.cityQuery) || await sha256(candidate.cityQuery);
      const hit = cached.get(key);
      if ((!hit || hit.precision !== 'city') && !cityRepresentative.has(candidate.cityQuery)) {
        cityRepresentative.set(candidate.cityQuery, candidate);
      }
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
      if (hit && hit.precision && hit.precision !== 'city') return hit;

      if (exactCalls > 0) await sleep(1100);
      exactCalls += 1;

      try {
        const url = new URL('https://nominatim.openstreetmap.org/search');
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('limit', '3');
        url.searchParams.set('addressdetails', '1');
        url.searchParams.set('countrycodes', 'br');
        url.searchParams.set('q', candidate.exactQuery);
        const response = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9' },
        });
        if (!response.ok) return null;
        const rows = await response.json();
        if (!Array.isArray(rows)) return null;

        const chosen = rows.find((row: any) =>
          nominatimStateMatches(row.address, candidate.state) &&
          nominatimCityMatches(row.address, candidate.cityName)
        );
        if (!chosen) return null;

        const lat = Number(chosen.lat);
        const lng = Number(chosen.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

        return await cacheLocation(
          candidate.exactQuery,
          lat,
          lng,
          String(chosen.display_name || candidate.exactQuery),
          'address',
          'nominatim',
        );
      } catch {
        return null;
      }
    }

    const points: any[] = [];

    for (const candidate of candidates) {
      let location: CachedLocation | DirectLocation | null = candidate.direct || null;

      if (!location && candidate.exactQuery) {
        const exactKey = queryKey.get(candidate.exactQuery) || await sha256(candidate.exactQuery);
        const exactHit = cached.get(exactKey);
        if (exactHit && exactHit.precision && exactHit.precision !== 'city') location = exactHit;
        if (!location) location = await geocodeExact(candidate);
      }

      if (!location && candidate.cityQuery) {
        const cityKey = queryKey.get(candidate.cityQuery) || await sha256(candidate.cityQuery);
        const cityHit = cached.get(cityKey);
        if (cityHit?.precision === 'city') location = cityHit;
      }

      if (!location) continue;

      points.push({
        id: candidate.id,
        kind: candidate.kind,
        lat: Number(location.lat),
        lng: Number(location.lng),
        precision: location.precision || 'city',
        location_source: location.source || null,
        location_label: location.display_name || null,
        ...candidate.payload,
      });
    }

    let route: any = null;

    if (selectedTechnicianId) {
      const stops = selectedAppointments
        .map((appointment) => points.find((point) => point.kind === 'appointment' && point.id === `appointment:${appointment.id}`))
        .filter(Boolean);
      const branchPoint = points.find((point) => point.kind === 'branch' && point.branch === selectedBranch);
      const routePoints = [branchPoint, ...stops].filter(Boolean);

      if (routePoints.length >= 2) {
        const coords = routePoints.map((point) => `${point.lng},${point.lat}`).join(';');
        try {
          const response = await fetch(
            `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`,
            { headers: { 'User-Agent': USER_AGENT } },
          );
          const json = await response.json();
          const geometry = json?.routes?.[0]?.geometry?.coordinates;
          if (response.ok && Array.isArray(geometry)) {
            route = {
              technician_id: selectedTechnicianId,
              approximate: false,
              origin_label: `Tracbel ${selectedBranch}`,
              geometry: geometry.map((item: number[]) => [item[1], item[0]]),
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

        let nearby = 0;
        for (const point of points) {
          if (point.kind !== 'client') continue;
          const distance = distanceToRouteKm([point.lat, point.lng], route.geometry);
          point.route_distance_km = Math.round(distance * 10) / 10;
          point.near_route = distance <= ROUTE_RADIUS_KM;
          if (point.near_route) nearby += 1;
        }
        route.nearby_clients = nearby;
        route.radius_km = ROUTE_RADIUS_KM;
      }
    }

    const clientPoints = points.filter((point) => point.kind === 'client');

    return new Response(JSON.stringify({
      points,
      route,
      unresolved: Math.max(0, clients.length - clientPoints.length),
      geocoded_now: geocodedNow,
      exact_external_calls: exactCalls,
      requested_clients: clients.length,
      located_clients: clientPoints.length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'map_context_failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
