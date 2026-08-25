import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const USER_AGENT = 'AgendaTecnicaRetencao/4.0 (+https://controle-agenda-six.vercel.app)';
const stateNames: Record<string, string> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
  PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

type EnrichmentRow = {
  client_key: string;
  client_name: string;
  branch: string;
  city: string | null;
  state: string | null;
  status: string;
  address: string | null;
  neighborhood: string | null;
  postal_code: string | null;
  lat: number | null;
  lng: number | null;
  precision: string | null;
  source: string | null;
};

function normalize(value?: string | null) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const legalTokens = new Set(['LTDA', 'LIMITADA', 'EIRELI', 'ME', 'EPP', 'SA', 'S', 'A', 'CIA', 'COMPANHIA']);

function nameTokens(value?: string | null) {
  return normalize(value).split(' ').filter((token) => token.length >= 2 && !legalTokens.has(token));
}

function trigramSet(value: string) {
  const normalized = `  ${normalize(value)}  `;
  const out = new Set<string>();
  for (let index = 0; index < normalized.length - 2; index += 1) out.add(normalized.slice(index, index + 3));
  return out;
}

function dice(a: string, b: string) {
  const aa = trigramSet(a);
  const bb = trigramSet(b);
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const item of aa) if (bb.has(item)) intersection += 1;
  return (2 * intersection) / (aa.size + bb.size);
}

function tokenOverlap(a: string, b: string) {
  const aa = new Set(nameTokens(a));
  const bb = new Set(nameTokens(b));
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const item of aa) if (bb.has(item)) intersection += 1;
  return intersection / Math.max(aa.size, bb.size);
}

function nameScore(a: string, b: string) {
  const na = nameTokens(a).join(' ');
  const nb = nameTokens(b).join(' ');
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const contains = na.length >= 7 && nb.length >= 7 && (na.includes(nb) || nb.includes(na)) ? 0.93 : 0;
  return Math.max(contains, 0.62 * dice(na, nb) + 0.38 * tokenOverlap(na, nb));
}

function foldState(state?: string | null) {
  const code = normalize(state);
  return normalize(stateNames[code] || state || '');
}

function stateMatches(address: Record<string, unknown> | undefined, targetState?: string | null) {
  if (!targetState) return false;
  const wantedCode = normalize(targetState);
  const wantedName = foldState(targetState);
  const actualName = normalize(String(address?.state || ''));
  const iso = normalize(String(address?.['ISO3166-2-lvl4'] || address?.['ISO3166-2-lvl3'] || '')).replace(/ /g, '-');
  return actualName === wantedName || iso.endsWith(`-${wantedCode}`);
}

function cityMatches(address: Record<string, unknown> | undefined, targetCity?: string | null) {
  if (!targetCity) return false;
  const wanted = normalize(targetCity);
  const values = [
    address?.city,
    address?.town,
    address?.village,
    address?.municipality,
    address?.county,
    address?.city_district,
  ].map((value) => normalize(String(value || ''))).filter(Boolean);
  return values.some((value) => value === wanted || value.includes(wanted) || wanted.includes(value));
}

function buildAddress(address: Record<string, unknown> | undefined) {
  if (!address) return null;
  const road = String(
    address.road || address.pedestrian || address.residential || address.industrial || address.commercial || address.place || '',
  ).trim();
  const number = String(address.house_number || '').trim();
  const neighborhood = String(address.suburb || address.neighbourhood || address.city_district || '').trim();
  const postcode = String(address.postcode || '').trim();
  if (!road) return null;
  const street = number ? `${road}, ${number}` : road;
  return [street, neighborhood, postcode].filter(Boolean).join(' - ');
}

function getNeighborhood(address: Record<string, unknown> | undefined) {
  return String(address?.suburb || address?.neighbourhood || address?.city_district || '').trim() || null;
}

function getPostcode(address: Record<string, unknown> | undefined) {
  return String(address?.postcode || '').trim() || null;
}

function rowName(result: any) {
  return String(result?.name || result?.namedetails?.name || '').trim();
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function nominatimSearch(query: string) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('namedetails', '1');
  url.searchParams.set('countrycodes', 'br');
  url.searchParams.set('q', query);
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9' },
  });
  if (!response.ok) throw new Error(`nominatim_http_${response.status}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

function exactQuery(row: EnrichmentRow) {
  return [row.address, row.neighborhood, row.city, row.state, 'Brasil']
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ');
}

function businessQuery(row: EnrichmentRow) {
  return [row.client_name, row.city, row.state, 'Brasil']
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });

  const db = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  try {
    const body = await req.json().catch(() => ({}));
    const batchSize = Math.max(1, Math.min(4, Number(body?.batch_size) || 3));
    await db.rpc('sync_client_address_enrichment');

    const { data: g4Rows, error: g4Error } = await db
      .from('client_address_enrichment')
      .select('client_key,client_name,branch,city,state,status,address,neighborhood,postal_code,lat,lng,precision,source')
      .eq('status', 'found')
      .eq('source', 'g4')
      .is('lat', null)
      .not('address', 'is', null)
      .limit(batchSize);
    if (g4Error) throw g4Error;

    let rows = (g4Rows || []) as EnrichmentRow[];
    let mode: 'g4_address' | 'business_search' = 'g4_address';

    if (!rows.length) {
      const { data: pendingRows, error: pendingError } = await db
        .from('client_address_enrichment')
        .select('client_key,client_name,branch,city,state,status,address,neighborhood,postal_code,lat,lng,precision,source')
        .eq('status', 'pending')
        .not('city', 'is', null)
        .not('state', 'is', null)
        .limit(batchSize);
      if (pendingError) throw pendingError;
      rows = (pendingRows || []) as EnrichmentRow[];
      mode = 'business_search';
    }

    if (!rows.length) {
      return new Response(JSON.stringify({ done: true }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    let found = 0;
    let cityOnly = 0;
    let ambiguous = 0;
    const processed: string[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (index > 0) await sleep(1100);

      const now = new Date().toISOString();
      const query = mode === 'g4_address' ? exactQuery(row) : businessQuery(row);
      const candidates = (await nominatimSearch(query)).filter((candidate: any) =>
        stateMatches(candidate.address, row.state) && cityMatches(candidate.address, row.city)
      );

      let selected: any = null;
      let selectedScore = 0;
      let isAmbiguous = false;

      if (mode === 'g4_address') {
        selected = candidates[0] || null;
        selectedScore = selected ? 1 : 0;
      } else {
        const ranked = candidates
          .map((candidate: any) => ({ candidate, score: nameScore(row.client_name, rowName(candidate)) }))
          .filter((item: any) => item.score >= 0.84 && buildAddress(item.candidate.address))
          .sort((a: any, b: any) => b.score - a.score);
        const best = ranked[0];
        const second = ranked[1];
        selected = best?.candidate || null;
        selectedScore = best?.score || 0;
        isAmbiguous = Boolean(best && second && second.score >= best.score - 0.06);
        if (selectedScore < 0.9 || isAmbiguous) selected = null;
      }

      if (selected) {
        const lat = Number(selected.lat);
        const lng = Number(selected.lon);
        const normalizedAddress = mode === 'g4_address' ? row.address : buildAddress(selected.address);
        if (Number.isFinite(lat) && Number.isFinite(lng) && normalizedAddress) {
          const { error } = await db.from('client_address_enrichment').update({
            status: 'found',
            address: normalizedAddress,
            neighborhood: mode === 'g4_address' ? row.neighborhood : getNeighborhood(selected.address),
            postal_code: mode === 'g4_address' ? row.postal_code : getPostcode(selected.address),
            lat,
            lng,
            precision: 'address',
            source: mode === 'g4_address' ? 'g4_geocoded' : 'nominatim_business',
            matched_name: mode === 'g4_address' ? null : rowName(selected),
            confidence: Number(selectedScore.toFixed(4)),
            metadata: {
              display_name: selected.display_name || null,
              osm_type: selected.osm_type || null,
              osm_id: selected.osm_id || null,
              query_mode: mode,
            },
            attempted_at: now,
            updated_at: now,
          }).eq('client_key', row.client_key);
          if (error) throw error;
          found += 1;
          processed.push(row.client_key);
          continue;
        }
      }

      if (mode === 'business_search' && isAmbiguous) {
        const { error } = await db.from('client_address_enrichment').update({
          status: 'ambiguous',
          lat: null,
          lng: null,
          precision: 'city',
          source: 'city_fallback',
          confidence: selectedScore ? Number(selectedScore.toFixed(4)) : null,
          attempted_at: now,
          updated_at: now,
        }).eq('client_key', row.client_key);
        if (error) throw error;
        ambiguous += 1;
      } else if (mode === 'business_search') {
        const { error } = await db.from('client_address_enrichment').update({
          status: 'city_only',
          lat: null,
          lng: null,
          precision: 'city',
          source: 'city_fallback',
          matched_name: null,
          attempted_at: now,
          updated_at: now,
        }).eq('client_key', row.client_key);
        if (error) throw error;
        cityOnly += 1;
      } else {
        const { error } = await db.from('client_address_enrichment').update({
          lat: null,
          lng: null,
          attempted_at: now,
          updated_at: now,
          metadata: { geocode_status: 'not_found', query_mode: mode },
        }).eq('client_key', row.client_key);
        if (error) throw error;
      }
      processed.push(row.client_key);
    }

    return new Response(JSON.stringify({
      done: false,
      mode,
      processed: processed.length,
      found,
      ambiguous,
      city_only: cityOnly,
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
