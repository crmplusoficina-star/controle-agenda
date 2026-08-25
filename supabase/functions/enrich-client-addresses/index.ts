import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const USER_AGENT = 'AgendaTecnicaRetencao/5.0 (+https://controle-agenda-six.vercel.app)';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const stateNames: Record<string, string> = {
  AC:'Acre',AL:'Alagoas',AP:'Amapá',AM:'Amazonas',BA:'Bahia',CE:'Ceará',DF:'Distrito Federal',
  ES:'Espírito Santo',GO:'Goiás',MA:'Maranhão',MT:'Mato Grosso',MS:'Mato Grosso do Sul',MG:'Minas Gerais',
  PA:'Pará',PB:'Paraíba',PR:'Paraná',PE:'Pernambuco',PI:'Piauí',RJ:'Rio de Janeiro',RN:'Rio Grande do Norte',
  RS:'Rio Grande do Sul',RO:'Rondônia',RR:'Roraima',SC:'Santa Catarina',SP:'São Paulo',SE:'Sergipe',TO:'Tocantins',
};

type EnrichmentRow = {
  client_key:string; client_name:string; branch:string; city:string|null; state:string|null;
  status:string; address:string|null; neighborhood:string|null; postal_code:string|null;
  lat:number|null; lng:number|null; precision:string|null; source:string|null;
};

type Candidate = {
  id:string; names:string[]; lat:number; lng:number; address:string|null;
  neighborhood:string|null; postalCode:string|null; tags:Record<string,string>;
};

function normalize(value?: string | null) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase()
    .replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}

const legal = new Set(['LTDA','LIMITADA','EIRELI','ME','EPP','SA','S','A','CIA','COMPANHIA']);
const generic = new Set(['DE','DA','DO','DAS','DOS','E','EM','COM','PARA','INDUSTRIA','INDUSTRIAL','COMERCIO','COMERCIAL','SERVICO','SERVICOS','CONSTRUCAO','CONSTRUCOES','CONSTRUTORA','TRANSPORTE','TRANSPORTES','EMPREENDIMENTO','EMPREENDIMENTOS','LOCACAO','LOCACOES']);

function nameTokens(value?: string | null, core = false) {
  return normalize(value).split(' ').filter((token) => token.length >= 2 && !legal.has(token) && (!core || !generic.has(token)));
}

function trigramSet(value:string) {
  const text = `  ${normalize(value)}  `;
  const out = new Set<string>();
  for (let i=0;i<text.length-2;i+=1) out.add(text.slice(i,i+3));
  return out;
}

function dice(a:string,b:string) {
  const aa=trigramSet(a), bb=trigramSet(b);
  if (!aa.size || !bb.size) return 0;
  let n=0; for (const item of aa) if (bb.has(item)) n+=1;
  return 2*n/(aa.size+bb.size);
}

function tokenOverlap(a:string,b:string) {
  const aa=new Set(nameTokens(a)), bb=new Set(nameTokens(b));
  if (!aa.size || !bb.size) return 0;
  let n=0; for (const item of aa) if (bb.has(item)) n+=1;
  return n/Math.max(aa.size,bb.size);
}

function nameScore(a:string,b:string) {
  const na=nameTokens(a).join(' '), nb=nameTokens(b).join(' ');
  if (!na || !nb) return 0;
  if (na===nb) return 1;
  const min=Math.min(na.length,nb.length), max=Math.max(na.length,nb.length);
  const contains=min>=8 && (na.includes(nb)||nb.includes(na)) ? 0.94+0.04*(min/max) : 0;
  return Math.max(contains,0.62*dice(na,nb)+0.38*tokenOverlap(na,nb));
}

function regexEscape(value:string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

function searchTerms(name:string) {
  const core=nameTokens(name,true).filter((t)=>t.length>=4).sort((a,b)=>b.length-a.length);
  const all=nameTokens(name).filter((t)=>t.length>=4).sort((a,b)=>b.length-a.length);
  const pool=[...core,...all];
  const out:string[]=[];
  for (const token of pool) {
    if (!out.includes(token)) out.push(token);
    if (out.length>=2) break;
  }
  return out;
}

function candidateAddress(tags:Record<string,string>) {
  const street=tags['addr:street']||tags['addr:place']||'';
  const number=tags['addr:housenumber']||'';
  const neighborhood=tags['addr:suburb']||tags['addr:neighbourhood']||'';
  const postal=tags['addr:postcode']||'';
  const line=street ? (number ? `${street}, ${number}` : street) : '';
  const parts=[line,neighborhood,postal].filter(Boolean);
  return parts.length ? parts.join(' - ') : null;
}

function cityCompatible(tags:Record<string,string>, city:string) {
  const wanted=normalize(city);
  const values=[tags['addr:city'],tags['addr:municipality'],tags['is_in:city'],tags['addr:county']]
    .map(normalize).filter(Boolean);
  if (!values.length) return true;
  return values.some((value)=>value===wanted || value.includes(wanted) || wanted.includes(value));
}

function stateCompatible(tags:Record<string,string>, state:string) {
  const wantedCode=normalize(state);
  const wantedName=normalize(stateNames[wantedCode]||state);
  const values=[tags['addr:state'],tags['is_in:state']].map(normalize).filter(Boolean);
  const iso=normalize(tags['ISO3166-2']||tags['addr:state_code']||'').replace(/ /g,'-');
  if (!values.length && !iso) return true;
  return values.some((value)=>value===wantedName || value===wantedCode) || iso.endsWith(`-${wantedCode}`);
}

async function cityCenter(city:string,state:string) {
  const url=new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name',city); url.searchParams.set('count','10'); url.searchParams.set('language','pt');
  url.searchParams.set('format','json'); url.searchParams.set('countryCode','BR');
  const response=await fetch(url,{headers:{'User-Agent':USER_AGENT}});
  if (!response.ok) return null;
  const json=await response.json();
  const rows=Array.isArray(json?.results)?json.results:[];
  const wanted=normalize(stateNames[normalize(state)]||state);
  const selected=rows.find((row:any)=>normalize(String(row.admin1||''))===wanted)
    || rows.find((row:any)=>String(row.country_code||'').toUpperCase()==='BR');
  if (!selected) return null;
  const lat=Number(selected.latitude), lng=Number(selected.longitude), population=Number(selected.population)||0;
  return Number.isFinite(lat)&&Number.isFinite(lng)?{lat,lng,population}:null;
}

function radiusMeters(population:number) {
  if (population>=1000000) return 32000;
  if (population>=400000) return 28000;
  if (population>=150000) return 24000;
  if (population>=50000) return 20000;
  return 16000;
}

async function fetchOverpass(lat:number,lng:number,radius:number,terms:string[]) {
  if (!terms.length) return [];
  const pattern=terms.map(regexEscape).join('|');
  const query=`[out:json][timeout:45];(nwr(around:${radius},${lat},${lng})[\"name\"~\"${pattern}\",i];nwr(around:${radius},${lat},${lng})[\"official_name\"~\"${pattern}\",i];nwr(around:${radius},${lat},${lng})[\"operator\"~\"${pattern}\",i];nwr(around:${radius},${lat},${lng})[\"brand\"~\"${pattern}\",i];);out center tags;`;
  let last='';
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),50000);
    try {
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':USER_AGENT},body:new URLSearchParams({data:query}),signal:controller.signal});
      if (!response.ok) { last=`http_${response.status}`; continue; }
      const json=await response.json();
      return Array.isArray(json?.elements)?json.elements:[];
    } catch (error) {
      last=error instanceof Error?error.message:String(error);
    } finally { clearTimeout(timeout); }
  }
  throw new Error(`overpass_failed:${last}`);
}

function toCandidates(elements:any[], city:string, state:string):Candidate[] {
  const out:Candidate[]=[];
  const seen=new Set<string>();
  for (const element of elements) {
    const tags=(element.tags||{}) as Record<string,string>;
    if (!cityCompatible(tags,city) || !stateCompatible(tags,state)) continue;
    const names=[tags.name,tags.official_name,tags.operator,tags.brand,tags.short_name].filter(Boolean).map(String);
    const lat=Number(element.lat??element.center?.lat), lng=Number(element.lon??element.center?.lon);
    const id=`${element.type}:${element.id}`;
    if (!names.length || !Number.isFinite(lat) || !Number.isFinite(lng) || seen.has(id)) continue;
    seen.add(id);
    out.push({id,names,lat,lng,address:candidateAddress(tags),neighborhood:tags['addr:suburb']||tags['addr:neighbourhood']||null,postalCode:tags['addr:postcode']||null,tags});
  }
  return out;
}

async function loadNextBatch(db:any,batchSize:number) {
  const baseSelect='client_key,client_name,branch,city,state,status,address,neighborhood,postal_code,lat,lng,precision,source';
  const {data:first,error:firstError}=await db.from('client_address_enrichment').select(baseSelect)
    .is('lat',null).not('city','is',null).not('state','is',null)
    .in('status',['pending','city_only','ambiguous','found'])
    .or('source.is.null,source.neq.bulk_osm_not_found')
    .order('city',{ascending:true}).order('state',{ascending:true}).limit(1);
  if (firstError) throw firstError;
  const seed=(first?.[0]||null) as EnrichmentRow|null;
  if (!seed?.city || !seed?.state) return null;
  const {data,error}=await db.from('client_address_enrichment').select(baseSelect)
    .is('lat',null).eq('city',seed.city).eq('state',seed.state)
    .in('status',['pending','city_only','ambiguous','found'])
    .or('source.is.null,source.neq.bulk_osm_not_found')
    .order('client_name',{ascending:true}).limit(batchSize);
  if (error) throw error;
  return {city:seed.city,state:seed.state,rows:(data||[]) as EnrichmentRow[]};
}

Deno.serve(async(req:Request)=>{
  if (req.method==='OPTIONS') return new Response('ok');
  if (req.method!=='POST') return new Response(JSON.stringify({error:'method_not_allowed'}),{status:405,headers:{'Content-Type':'application/json'}});
  const db=createClient(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',{auth:{persistSession:false,autoRefreshToken:false}});
  try {
    const body=await req.json().catch(()=>({}));
    const batchSize=Math.max(10,Math.min(35,Number(body?.batch_size)||30));
    const maxBatches=Math.max(1,Math.min(3,Number(body?.batches)||3));
    await db.rpc('sync_client_address_enrichment');
    const summary:any[]=[];

    for (let batchIndex=0;batchIndex<maxBatches;batchIndex+=1) {
      const batch=await loadNextBatch(db,batchSize);
      if (!batch || !batch.rows.length) break;
      const center=await cityCenter(batch.city,batch.state);
      const now=new Date().toISOString();
      if (!center) {
        for (const row of batch.rows) await db.from('client_address_enrichment').update({status:'city_only',lat:null,lng:null,precision:'city',source:'bulk_osm_not_found',attempted_at:now,updated_at:now}).eq('client_key',row.client_key);
        summary.push({city:batch.city,state:batch.state,processed:batch.rows.length,found:0,reason:'city_center_not_found'});
        continue;
      }

      const terms=Array.from(new Set(batch.rows.flatMap((row)=>searchTerms(row.client_name)))).slice(0,70);
      const candidates=toCandidates(await fetchOverpass(center.lat,center.lng,radiusMeters(center.population),terms),batch.city,batch.state);
      let found=0;
      for (const row of batch.rows) {
        const ranked=candidates.map((candidate)=>({candidate,score:Math.max(...candidate.names.map((name)=>nameScore(row.client_name,name)))}))
          .filter((item)=>item.score>=0.90).sort((a,b)=>b.score-a.score);
        const best=ranked[0], second=ranked[1];
        const ambiguous=Boolean(best&&second&&second.score>=best.score-0.055);
        const accepted=Boolean(best&&best.score>=0.94&&!ambiguous);
        if (accepted && best) {
          const matched=[...best.candidate.names].sort((a,b)=>nameScore(row.client_name,b)-nameScore(row.client_name,a))[0];
          const {error}=await db.from('client_address_enrichment').update({
            status:'found',address:best.candidate.address||row.address,neighborhood:best.candidate.neighborhood||row.neighborhood,
            postal_code:best.candidate.postalCode||row.postal_code,lat:best.candidate.lat,lng:best.candidate.lng,
            precision:best.candidate.address?'address':'poi',source:'openstreetmap_bulk',matched_name:matched,
            confidence:Number(best.score.toFixed(4)),metadata:{osm_id:best.candidate.id,batch_city:batch.city,tags:best.candidate.tags},
            attempted_at:now,updated_at:now,
          }).eq('client_key',row.client_key);
          if (error) throw error;
          found+=1;
        } else {
          const {error}=await db.from('client_address_enrichment').update({
            status:ambiguous?'ambiguous':'city_only',lat:null,lng:null,precision:'city',source:'bulk_osm_not_found',
            matched_name:best?.candidate.names[0]||null,confidence:best?Number(best.score.toFixed(4)):null,
            metadata:{batch_city:batch.city,candidates:ranked.slice(0,3).map((item)=>({name:item.candidate.names[0],score:Number(item.score.toFixed(4)),osm_id:item.candidate.id}))},
            attempted_at:now,updated_at:now,
          }).eq('client_key',row.client_key);
          if (error) throw error;
        }
      }
      summary.push({city:batch.city,state:batch.state,processed:batch.rows.length,found,candidates:candidates.length});
    }

    const {count:remaining}=await db.from('client_address_enrichment').select('*',{head:true,count:'exact'})
      .is('lat',null).not('city','is',null).not('state','is',null)
      .in('status',['pending','city_only','ambiguous','found'])
      .or('source.is.null,source.neq.bulk_osm_not_found');
    return new Response(JSON.stringify({done:(remaining||0)===0,remaining:remaining||0,batches:summary}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({error:error instanceof Error?error.message:String(error)}),{status:500,headers:{'Content-Type':'application/json'}});
  }
});
