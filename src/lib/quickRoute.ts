import { supabase } from './supabase';

// Estimativa imediata da distância do atendimento anterior, calculada no navegador
// com as mesmas regras do worker da nuvem (origem = atendimento anterior da semana ou a filial).

type Point = { lat: number; lng: number; label: string };
export type QuickRoute = { km: number; min: number; from: string; to: string; approx: boolean };

const BRANCHES: Record<string, Point> = {
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

const BRANCH_STATE: Record<string, string> = {
  BALSAS: 'MA', IMPERATRIZ: 'MA', ITAITINGA: 'CE', 'SAO LUIS': 'MA', TERESINA: 'PI',
  MARITUBA: 'PA', MARABA: 'PA', MIRITITUBA: 'PA', MANAUS: 'AM', OURILANDIA: 'PA',
};

const STATE_NAMES: Record<string, string> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul',
  MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí',
  RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia',
  RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

const fold = (value?: string | null) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
const CACHE_KEY = 'quick-route-cache-v1';

function cache(): Record<string, any> {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function remember(key: string, value: any) {
  try {
    const all = cache();
    all[key] = value;
    const keys = Object.keys(all);
    if (keys.length > 800) for (const k of keys.slice(0, keys.length - 800)) delete all[k];
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* sem armazenamento */ }
}

function parseCityState(value: string) {
  const match = value.trim().match(/^(.*?)(?:\s*\/\s*|\s+-\s+)([A-Za-z]{2})$/);
  return match ? { city: match[1].trim(), state: fold(match[2]) } : { city: value.trim(), state: '' };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function geocode(rawCity: string, branch: string): Promise<Point | null> {
  const branchKey = fold(branch);
  if (fold(rawCity) === branchKey && BRANCHES[branchKey]) return { ...BRANCHES[branchKey], label: rawCity.trim() };
  const parsed = parseCityState(rawCity);
  if (!parsed.city) return null;
  const state = parsed.state || BRANCH_STATE[branchKey] || '';
  const key = `geo|${fold(parsed.city)}|${state}`;
  const hit = cache()[key];
  if (hit) return hit;
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', parsed.city);
  url.searchParams.set('count', '20');
  url.searchParams.set('language', 'pt');
  url.searchParams.set('countryCode', 'BR');
  const response = await withTimeout(fetch(url), 5000);
  if (!response?.ok) return null;
  const results: any[] = (await response.json())?.results || [];
  const sameName = results.filter((r) => fold(r.name) === fold(parsed.city));
  const desiredState = fold(STATE_NAMES[state] || state);
  // Mesmo nome no estado da filial; se não houver, o mais próximo da filial.
  let chosen = sameName.find((r) => fold(r.admin1) === desiredState);
  const base = BRANCHES[branchKey];
  if (!chosen && sameName.length && base) chosen = sameName.sort((a, b) => Math.hypot(a.latitude - base.lat, a.longitude - base.lng) - Math.hypot(b.latitude - base.lat, b.longitude - base.lng))[0];
  if (!chosen) return null;
  const point = { lat: Number(chosen.latitude), lng: Number(chosen.longitude), label: parsed.city };
  remember(key, point);
  return point;
}

function haversineKm(a: Point, b: Point) {
  const rad = (v: number) => v * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

async function road(a: Point, b: Point): Promise<{ km: number; min: number; approx: boolean }> {
  if (haversineKm(a, b) < 0.05) return { km: 0, min: 0, approx: false };
  const key = `road|${a.lat.toFixed(4)},${a.lng.toFixed(4)}>${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
  const hit = cache()[key];
  if (hit) return hit;
  const coords = `${a.lng},${a.lat};${b.lng},${b.lat}`;
  for (const base of ['https://router.project-osrm.org/route/v1/driving', 'https://routing.openstreetmap.de/routed-car/route/v1/driving']) {
    try {
      const response = await withTimeout(fetch(`${base}/${coords}?overview=false&steps=false`), 6000);
      if (!response?.ok) continue;
      const best = (await response.json())?.routes?.[0];
      if (!best) continue;
      const result = { km: Math.round((Number(best.distance) / 1000) * 10) / 10, min: Math.round(Number(best.duration) / 60), approx: false };
      remember(key, result);
      return result;
    } catch { /* tenta o próximo */ }
  }
  // Sem roteador: linha reta x 1,3 (fator típico de estrada), marcado como aproximado.
  const km = Math.round(haversineKm(a, b) * 1.3);
  return { km, min: km, approx: true }; // ~60 km/h
}

function weekStart(date: string) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const ignored = (reason?: string | null) => ['SEM AGENDA', 'FOLGA', 'FERIAS'].includes(fold(reason));
const branchReturn = (reason?: string | null, description?: string | null) => { const t = fold(`${reason || ''} ${description || ''}`); return t.includes('RETORNO') && t.includes('FILIAL'); };

export async function estimateRoute(input: {
  id?: string; technician_id: string; appointment_date: string; branch: string; service_city: string;
  service_reason?: string; description?: string; created_at?: string | null;
}): Promise<QuickRoute | null> {
  if (!input.technician_id || !input.appointment_date || ignored(input.service_reason)) return null;
  const isReturn = branchReturn(input.service_reason, input.description);
  if (!input.service_city.trim() && !isReturn) return null;
  const base = BRANCHES[fold(input.branch)];

  const destination = isReturn ? base : await geocode(input.service_city, input.branch);
  if (!destination) return null;

  // Atendimento anterior do técnico na mesma semana (mesma regra do worker).
  const { data } = await supabase.from('appointments')
    .select('id,appointment_date,service_city,service_reason,description,created_at,branch')
    .eq('technician_id', input.technician_id)
    .gte('appointment_date', weekStart(input.appointment_date))
    .lte('appointment_date', input.appointment_date)
    .order('appointment_date').order('created_at').limit(60);
  const mine = input.created_at || '9999';
  const before = (data || []).filter((r: any) => r.id !== input.id && !ignored(r.service_reason)
    && (r.appointment_date < input.appointment_date || String(r.created_at || '') < mine));
  let origin: Point | null = base || null;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const prev: any = before[i];
    if (branchReturn(prev.service_reason, prev.description)) { origin = base || null; break; }
    if (!prev.service_city) continue;
    const point = await geocode(prev.service_city, prev.branch || input.branch);
    if (point) { origin = point; break; }
  }
  if (!origin) return null;
  const leg = await road(origin, destination);
  return { ...leg, from: origin.label, to: destination.label };
}
