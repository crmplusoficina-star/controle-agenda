import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const USER_AGENT = 'AgendaTecnicaRetencao/1.0 (+https://controle-agenda.vercel.app)';
const MAX_EXTERNAL_GEOCODES = 10;

type ClientInput = { client_key: string; client_name: string; branch: string; city?: string | null; last_service_at?: string | null; serials?: string[] };
type AppointmentInput = { id: string; branch: string; appointment_date: string; technician_id: string; technician_name?: string | null; client_name?: string | null; equipment_serial?: string | null; service_city?: string | null };
type G4Row = { razao_social: string | null; numero_serie: string | null; endereco: string | null; bairro: string | null; cidade_contato: string | null; cidade: string | null; estado: string | null; filial: string | null; data_fechamento: string | null; data_inicio: string | null; data_abertura: string | null };

function normalize(value: string) { return value.trim().replace(/\s+/g, ' ').toUpperCase(); }
function rowDate(row: G4Row) { return row.data_fechamento || row.data_inicio || row.data_abertura || ''; }
function locationText(row: G4Row | undefined, fallbackCity?: string | null) {
  const city = row?.cidade_contato || row?.cidade || fallbackCity || '';
  return [row?.endereco, row?.bairro, city, row?.estado, 'Brasil'].map((value) => String(value || '').trim()).filter(Boolean).join(', ');
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalize(value)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sleep(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const clients = (Array.isArray(body.clients) ? body.clients : []).slice(0, 40) as ClientInput[];
    const appointments = (Array.isArray(body.appointments) ? body.appointments : []).slice(0, 30) as AppointmentInput[];
    const selectedTechnicianId = typeof body.technician_id === 'string' ? body.technician_id : '';

    const supabase = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', { auth: { persistSession: false, autoRefreshToken: false } });
    const clientNames = Array.from(new Set(clients.map((c) => c.client_name).filter(Boolean)));
    const serials = Array.from(new Set(appointments.map((a) => a.equipment_serial || '').filter(Boolean)));
    const branches = Array.from(new Set([...clients.map((c) => c.branch), ...appointments.map((a) => a.branch)].filter(Boolean)));

    const g4Rows: G4Row[] = [];
    if (clientNames.length && branches.length) {
      const { data } = await supabase.from('g4_ordens_servico').select('razao_social,numero_serie,endereco,bairro,cidade_contato,cidade,estado,filial,data_fechamento,data_inicio,data_abertura').in('razao_social', clientNames).in('filial', branches).limit(5000);
      if (data) g4Rows.push(...(data as G4Row[]));
    }
    if (serials.length) {
      const { data } = await supabase.from('g4_ordens_servico').select('razao_social,numero_serie,endereco,bairro,cidade_contato,cidade,estado,filial,data_fechamento,data_inicio,data_abertura').in('numero_serie', serials).limit(3000);
      if (data) g4Rows.push(...(data as G4Row[]));
    }

    const latestClient = new Map<string, G4Row>();
    const latestSerial = new Map<string, G4Row>();
    for (const row of g4Rows) {
      if (row.razao_social && row.filial) {
        const key = `${normalize(row.razao_social)}|${normalize(row.filial)}`;
        const current = latestClient.get(key);
        if (!current || rowDate(row) > rowDate(current)) latestClient.set(key, row);
      }
      if (row.numero_serie) {
        const key = normalize(row.numero_serie);
        const current = latestSerial.get(key);
        if (!current || rowDate(row) > rowDate(current)) latestSerial.set(key, row);
      }
    }

    const selectedAppointments = appointments.filter((a) => !selectedTechnicianId || a.technician_id === selectedTechnicianId).sort((a, b) => a.appointment_date.localeCompare(b.appointment_date));
    const selectedBranch = selectedAppointments[0]?.branch || '';
    let branchAddress = '';
    if (selectedBranch) {
      const { data } = await supabase.from('app_branches').select('address').eq('name', selectedBranch).maybeSingle();
      branchAddress = String(data?.address || '').trim();
    }

    type Candidate = { id: string; kind: 'branch' | 'appointment' | 'client'; query: string; fallbackQuery?: string; payload: Record<string, unknown> };
    const candidates: Candidate[] = [];
    if (selectedBranch && branchAddress) candidates.push({ id: `branch:${selectedBranch}`, kind: 'branch', query: branchAddress, fallbackQuery: `${selectedBranch}, Brasil`, payload: { branch: selectedBranch, name: `Tracbel ${selectedBranch}` } });

    for (const appointment of appointments) {
      const serialRow = appointment.equipment_serial ? latestSerial.get(normalize(appointment.equipment_serial)) : undefined;
      const clientRow = appointment.client_name ? latestClient.get(`${normalize(appointment.client_name)}|${normalize(appointment.branch)}`) : undefined;
      const row = serialRow || clientRow;
      const query = locationText(row, appointment.service_city);
      if (!query) continue;
      candidates.push({ id: `appointment:${appointment.id}`, kind: 'appointment', query, fallbackQuery: `${appointment.service_city || row?.cidade_contato || row?.cidade || ''}, ${row?.estado || ''}, Brasil`, payload: { ...appointment } });
    }

    for (const client of clients) {
      const row = latestClient.get(`${normalize(client.client_name)}|${normalize(client.branch)}`);
      const query = locationText(row, client.city);
      if (!query) continue;
      candidates.push({ id: `client:${client.client_key}`, kind: 'client', query, fallbackQuery: `${client.city || row?.cidade_contato || row?.cidade || ''}, ${row?.estado || ''}, Brasil`, payload: { ...client } });
    }

    const uniqueQueries = Array.from(new Set(candidates.map((c) => c.query).filter(Boolean)));
    const cacheKeys = await Promise.all(uniqueQueries.map(sha256));
    const queryKeyMap = new Map(uniqueQueries.map((query, index) => [query, cacheKeys[index]]));
    const cached = new Map<string, any>();
    if (cacheKeys.length) {
      const { data } = await supabase.from('map_location_cache').select('cache_key,query,lat,lng,display_name,precision,source').in('cache_key', cacheKeys);
      for (const row of data || []) cached.set(row.cache_key, row);
    }

    let externalCalls = 0;
    let geocodedNow = 0;
    async function resolveLocation(candidate: Candidate) {
      const primaryKey = queryKeyMap.get(candidate.query) || await sha256(candidate.query);
      const hit = cached.get(primaryKey);
      if (hit) return hit;
      if (externalCalls >= MAX_EXTERNAL_GEOCODES) return null;

      async function fetchNominatim(query: string, precision: string) {
        if (!query || externalCalls >= MAX_EXTERNAL_GEOCODES) return null;
        if (externalCalls > 0) await sleep(1100);
        externalCalls += 1;
        const url = new URL('https://nominatim.openstreetmap.org/search');
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('limit', '1');
        url.searchParams.set('countrycodes', 'br');
        url.searchParams.set('q', query);
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9' } });
        if (!response.ok) return null;
        const rows = await response.json();
        if (!Array.isArray(rows) || !rows[0]) return null;
        const result = { lat: Number(rows[0].lat), lng: Number(rows[0].lon), display_name: String(rows[0].display_name || query), precision, source: 'nominatim' };
        const key = await sha256(query);
        await supabase.from('map_location_cache').upsert({ cache_key: key, query, ...result, updated_at: new Date().toISOString() });
        cached.set(key, { cache_key: key, query, ...result });
        geocodedNow += 1;
        return { cache_key: key, query, ...result };
      }

      const exact = await fetchNominatim(candidate.query, 'address');
      if (exact) return exact;
      if (candidate.fallbackQuery && normalize(candidate.fallbackQuery) !== normalize(candidate.query)) {
        const fallbackKey = await sha256(candidate.fallbackQuery);
        const fallbackHit = cached.get(fallbackKey);
        if (fallbackHit) return fallbackHit;
        return await fetchNominatim(candidate.fallbackQuery, 'city');
      }
      return null;
    }

    const points: any[] = [];
    for (const candidate of candidates) {
      const location = await resolveLocation(candidate);
      if (!location) continue;
      points.push({ id: candidate.id, kind: candidate.kind, lat: location.lat, lng: location.lng, precision: location.precision, ...candidate.payload });
    }

    let route: any = null;
    if (selectedTechnicianId) {
      const orderedStops = selectedAppointments.map((appointment) => points.find((point) => point.kind === 'appointment' && point.id === `appointment:${appointment.id}`)).filter(Boolean);
      const branchPoint = points.find((point) => point.kind === 'branch' && point.branch === selectedBranch);
      const routePoints = [branchPoint, ...orderedStops].filter(Boolean);
      if (routePoints.length >= 2) {
        const coords = routePoints.map((point) => `${point.lng},${point.lat}`).join(';');
        try {
          const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`, { headers: { 'User-Agent': USER_AGENT } });
          const data = await response.json();
          const geometry = data?.routes?.[0]?.geometry?.coordinates;
          if (response.ok && Array.isArray(geometry)) route = { technician_id: selectedTechnicianId, approximate: false, origin_label: `Tracbel ${selectedBranch}`, geometry: geometry.map((pair: number[]) => [pair[1], pair[0]]) };
        } catch (_) { /* fallback below */ }
        if (!route) route = { technician_id: selectedTechnicianId, approximate: true, origin_label: `Tracbel ${selectedBranch}`, geometry: routePoints.map((point) => [point.lat, point.lng]) };
      }
    }

    const resolvedIds = new Set(points.map((point) => point.id));
    const unresolved = candidates.filter((candidate) => !resolvedIds.has(candidate.id)).length;
    return new Response(JSON.stringify({ points, route, unresolved, geocoded_now: geocodedNow, external_calls: externalCalls }), { headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'map_context_failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
