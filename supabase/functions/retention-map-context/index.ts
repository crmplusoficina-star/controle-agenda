import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const USER_AGENT = 'AgendaTecnicaRetencao/6.0';
const PAGE_SIZE = 1000;
const EXACT_GEOCODE_LIMIT = 8;

const stateNames: Record<string, string> = {
  AC:'Acre',AL:'Alagoas',AP:'Amapá',AM:'Amazonas',BA:'Bahia',CE:'Ceará',DF:'Distrito Federal',ES:'Espírito Santo',GO:'Goiás',MA:'Maranhão',MT:'Mato Grosso',MS:'Mato Grosso do Sul',MG:'Minas Gerais',PA:'Pará',PB:'Paraíba',PR:'Paraná',PE:'Pernambuco',PI:'Piauí',RJ:'Rio de Janeiro',RN:'Rio Grande do Norte',RS:'Rio Grande do Sul',RO:'Rondônia',RR:'Roraima',SC:'Santa Catarina',SP:'São Paulo',SE:'Sergipe',TO:'Tocantins'
};

type ClientInput={client_key:string;client_name:string;branch:string;city?:string|null;last_service_at?:string|null};
type AppointmentInput={id:string;branch:string;appointment_date:string;technician_id:string;technician_name?:string|null;client_name?:string|null;equipment_serial?:string|null;service_city?:string|null;service_reason?:string|null;description?:string|null};
type ClientLocation={client_key:string;client_name:string;branch:string;address:string|null;neighborhood:string|null;city:string|null;state:string|null};
type CacheRow={cache_key:string;query:string;lat:number;lng:number;display_name:string|null;precision:string|null;source:string|null};
type Candidate={id:string;kind:'branch'|'appointment'|'client';query?:string;cityQuery?:string;cityName?:string;state?:string;payload:Record<string,unknown>;locationUncertain?:boolean;uncertainReason?:string};

const normalize=(v:string)=>v.trim().replace(/\s+/g,' ').toUpperCase();
const fold=(v?:string|null)=>normalize(String(v||'')).normalize('NFD').replace(/\p{Diacritic}/gu,'');
const buildExact=(address?:string|null,neighborhood?:string|null,city?:string|null,state?:string|null)=>String(address||'').trim()?[address,neighborhood,city,state,'Brasil'].map(v=>String(v||'').trim()).filter(Boolean).join(', '):'';
const buildCity=(city?:string|null,state?:string|null)=>String(city||'').trim()&&String(state||'').trim()?[city,state,'Brasil'].map(v=>String(v||'').trim()).join(', '):'';
const parseState=(address:string)=>address.toUpperCase().match(/-\s*([A-Z]{2})(?:,|\s+BRASIL)/)?.[1]||'';
async function sha256(v:string){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(normalize(v)));return Array.from(new Uint8Array(d)).map(b=>b.toString(16).padStart(2,'0')).join('')}

function inferState(locations:ClientLocation[],city:string,branch:string){
  const cityKey=fold(city);
  if(!cityKey)return {state:'',confidence:'none'};
  const sameCity=locations.filter(r=>fold(r.city)===cityKey&&String(r.state||'').trim());
  if(!sameCity.length)return {state:'',confidence:'none'};
  const sameBranch=sameCity.filter(r=>fold(r.branch)===fold(branch));
  const evidence=sameBranch.length?sameBranch:sameCity;
  const counts=new Map<string,number>();
  for(const row of evidence){const state=normalize(String(row.state||''));if(state)counts.set(state,(counts.get(state)||0)+1);}
  const ranked=[...counts.entries()].sort((a,b)=>b[1]-a[1]);
  if(ranked.length===1)return {state:ranked[0][0],confidence:sameBranch.length?'branch-city':'city'};
  const [first,second]=ranked;
  if(first&&first[1]>=3&&first[1]>=second[1]*4)return {state:first[0],confidence:'dominant'};
  return {state:'',confidence:'ambiguous'};
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders});
  if(req.method!=='POST') return new Response(JSON.stringify({error:'method_not_allowed'}),{status:405,headers:{...corsHeaders,'Content-Type':'application/json'}});
  try{
    const body=await req.json();
    const clients=(Array.isArray(body.clients)?body.clients:[]) as ClientInput[];
    const appointments=(Array.isArray(body.appointments)?body.appointments:[]) as AppointmentInput[];
    const selectedTechnicianId=typeof body.technician_id==='string'?body.technician_id:'';
    const db=createClient(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',{auth:{persistSession:false,autoRefreshToken:false}});

    const branches=Array.from(new Set([...clients.map(c=>c.branch),...appointments.map(a=>a.branch)].filter(Boolean)));
    const locations:ClientLocation[]=[];
    for(let from=0;;from+=PAGE_SIZE){let q=db.from('g4_client_location_summary').select('client_key,client_name,branch,address,neighborhood,city,state').range(from,from+PAGE_SIZE-1);if(branches.length)q=q.in('branch',branches);const {data,error}=await q;if(error)throw error;const page=(data||[]) as ClientLocation[];locations.push(...page);if(page.length<PAGE_SIZE)break;}
    const byKey=new Map(locations.map(r=>[r.client_key,r]));
    const byClientBranch=new Map(locations.map(r=>[`${normalize(r.client_name)}|${normalize(r.branch)}`,r]));

    const selectedAppointments=appointments.filter(a=>!selectedTechnicianId||a.technician_id===selectedTechnicianId).sort((a,b)=>a.appointment_date.localeCompare(b.appointment_date)||a.id.localeCompare(b.id));
    const selectedBranch=selectedAppointments[0]?.branch||'';
    let branchAddress='',branchState='';
    if(selectedBranch){const {data}=await db.from('app_branches').select('address').eq('name',selectedBranch).maybeSingle();branchAddress=String(data?.address||'').trim();branchState=parseState(branchAddress);}

    const candidates:Candidate[]=[];
    if(selectedBranch)candidates.push({id:`branch:${selectedBranch}`,kind:'branch',query:branchAddress||undefined,cityQuery:buildCity(selectedBranch,branchState)||undefined,cityName:selectedBranch,state:branchState||undefined,payload:{branch:selectedBranch,name:`Tracbel ${selectedBranch}`,city:selectedBranch,state:branchState||null}});

    for(const a of appointments){
      const base=a.client_name?byClientBranch.get(`${normalize(a.client_name)}|${normalize(a.branch)}`):undefined;
      const serviceCity=String(a.service_city||'').trim();
      const baseCity=String(base?.city||'').trim();
      const city=serviceCity||baseCity;
      const sameCityAsBase=Boolean(city&&baseCity&&fold(city)===fold(baseCity));
      const inferred=inferState(locations,city,a.branch);
      const state=sameCityAsBase&&String(base?.state||'').trim()?String(base?.state||'').trim():inferred.state;
      const canReuseAddress=Boolean(base?.address&&sameCityAsBase&&(!state||fold(base?.state)===fold(state)));
      const uncertain=Boolean(serviceCity&&(!state||inferred.confidence==='ambiguous'));
      const reason=!serviceCity&&!city?'Cidade não informada':inferred.confidence==='ambiguous'?`Há mais de um estado possível para ${city}`:!state?`Não foi possível confirmar o estado de ${city}`:'';
      candidates.push({
        id:`appointment:${a.id}`,
        kind:'appointment',
        query:canReuseAddress?buildExact(base?.address,base?.neighborhood,city,state)||undefined:undefined,
        cityQuery:!uncertain?buildCity(city,state)||undefined:undefined,
        cityName:city||undefined,
        state:state||undefined,
        locationUncertain:uncertain||!city,
        uncertainReason:reason||undefined,
        payload:{...a,city:city||null,state:state||null,location_state_confidence:inferred.confidence}
      });
    }

    for(const c of clients){const base=byKey.get(c.client_key)||byClientBranch.get(`${normalize(c.client_name)}|${normalize(c.branch)}`);const city=String(c.city||base?.city||'').trim();const state=String(base?.state||'').trim();candidates.push({id:`client:${c.client_key}`,kind:'client',query:buildExact(base?.address,base?.neighborhood,city,state)||undefined,cityQuery:buildCity(city,state)||undefined,cityName:city||undefined,state:state||undefined,payload:{...c,city:city||null,state:state||null}});}

    const queries=Array.from(new Set(candidates.flatMap(c=>[c.query,c.cityQuery]).filter(Boolean) as string[]));
    const keyPairs=await Promise.all(queries.map(async q=>[q,await sha256(q)] as const));
    const queryKey=new Map(keyPairs);const cache=new Map<string,CacheRow>();
    const keys=keyPairs.map(([,k])=>k);
    for(let i=0;i<keys.length;i+=200){const {data,error}=await db.from('map_location_cache').select('cache_key,query,lat,lng,display_name,precision,source').in('cache_key',keys.slice(i,i+200));if(error)throw error;for(const row of data||[])cache.set(row.cache_key,row as CacheRow);}
    let geocodedNow=0;
    async function saveCache(query:string,lat:number,lng:number,display:string,precision:string,source:string){const key=queryKey.get(query)||await sha256(query);const row={cache_key:key,query,lat,lng,display_name:display,precision,source,updated_at:new Date().toISOString()};await db.from('map_location_cache').upsert(row);cache.set(key,row as CacheRow);geocodedNow++;return row as CacheRow;}

    const cityCandidates=new Map<string,Candidate>();
    for(const c of candidates)if(c.cityQuery&&c.cityName&&c.state&&!c.locationUncertain)cityCandidates.set(c.cityQuery,c);
    for(const c of cityCandidates.values()){
      const key=queryKey.get(c.cityQuery!)||await sha256(c.cityQuery!);if(cache.get(key)?.precision==='city')continue;
      try{const u=new URL('https://geocoding-api.open-meteo.com/v1/search');u.searchParams.set('name',c.cityName!);u.searchParams.set('count','20');u.searchParams.set('language','pt');u.searchParams.set('format','json');u.searchParams.set('countryCode','BR');const r=await fetch(u,{headers:{'User-Agent':USER_AGENT}});if(!r.ok)continue;const j=await r.json();const desiredState=fold(stateNames[normalize(c.state!)]||c.state);const desiredCity=fold(c.cityName);const chosen=(Array.isArray(j?.results)?j.results:[]).find((x:any)=>fold(String(x.name||''))===desiredCity&&fold(String(x.admin1||''))===desiredState&&String(x.country_code||'').toUpperCase()==='BR');if(chosen)await saveCache(c.cityQuery!,Number(chosen.latitude),Number(chosen.longitude),`${chosen.name}, ${chosen.admin1}`,'city','open-meteo');}catch{}
    }

    let exactCalls=0;
    async function resolve(c:Candidate):Promise<CacheRow|null>{
      if(c.locationUncertain)return null;
      if(c.query){const key=queryKey.get(c.query)||await sha256(c.query);const hit=cache.get(key);if(hit&&hit.precision!=='city')return hit;if(exactCalls<EXACT_GEOCODE_LIMIT){exactCalls++;try{const u=new URL('https://nominatim.openstreetmap.org/search');u.searchParams.set('format','jsonv2');u.searchParams.set('limit','1');u.searchParams.set('countrycodes','br');u.searchParams.set('q',c.query);const r=await fetch(u,{headers:{'User-Agent':USER_AGENT,'Accept-Language':'pt-BR'}});if(r.ok){const rows=await r.json();const x=Array.isArray(rows)?rows[0]:null;if(x)return await saveCache(c.query,Number(x.lat),Number(x.lon),String(x.display_name||c.query),'address','nominatim');}}catch{}}
      }
      if(c.cityQuery){const key=queryKey.get(c.cityQuery)||await sha256(c.cityQuery);const hit=cache.get(key);if(hit?.precision==='city')return hit;}
      return null;
    }

    const points:any[]=[];
    const unresolvedAppointments:Candidate[]=[];
    for(const c of candidates){const loc=await resolve(c);if(!loc){if(c.kind==='appointment')unresolvedAppointments.push(c);continue;}points.push({id:c.id,kind:c.kind,lat:Number(loc.lat),lng:Number(loc.lng),precision:loc.precision||'city',location_source:loc.source||null,location_label:loc.display_name||null,location_uncertain:false,...c.payload});}

    for(const c of unresolvedAppointments){
      const branch=String(c.payload.branch||'');
      const branchPoint=points.find(p=>p.kind==='branch'&&fold(p.branch)===fold(branch));
      if(!branchPoint)continue;
      points.push({id:c.id,kind:'appointment',lat:branchPoint.lat,lng:branchPoint.lng,precision:'uncertain',location_source:'branch-fallback',location_label:`Localização incerta · ${c.cityName||'cidade não informada'}`,location_uncertain:true,location_uncertain_reason:c.uncertainReason||'Destino não pôde ser validado com segurança',...c.payload});
    }

    let route:any=null;
    if(selectedTechnicianId){
      const stops=selectedAppointments.map(a=>points.find(p=>p.kind==='appointment'&&p.id===`appointment:${a.id}`&&!p.location_uncertain)).filter(Boolean);
      const branchPoint=points.find(p=>p.kind==='branch'&&p.branch===selectedBranch);
      const routePoints=[branchPoint,...stops].filter(Boolean);
      if(routePoints.length>=2){
        const coords=routePoints.map(p=>`${p.lng},${p.lat}`).join(';');
        try{const r=await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`,{headers:{'User-Agent':USER_AGENT}});const j=await r.json();const best=j?.routes?.[0];const geometry=best?.geometry?.coordinates;if(r.ok&&Array.isArray(geometry)){route={technician_id:selectedTechnicianId,approximate:false,origin_label:`Tracbel ${selectedBranch}`,geometry:geometry.map((x:number[])=>[x[1],x[0]]),distance_km:Math.round((Number(best.distance||0)/1000)*10)/10,duration_min:Math.round(Number(best.duration||0)/60),legs:(best.legs||[]).map((leg:any,index:number)=>({index:index+1,distance_km:Math.round((Number(leg.distance||0)/1000)*10)/10,duration_min:Math.round(Number(leg.duration||0)/60)}))};}}catch{}
        if(!route)route={technician_id:selectedTechnicianId,approximate:true,routing_error:true,origin_label:`Tracbel ${selectedBranch}`,geometry:[]};
      }
    }

    const clientPoints=points.filter(p=>p.kind==='client');
    const uncertainAppointments=points.filter(p=>p.kind==='appointment'&&p.location_uncertain).length;
    return new Response(JSON.stringify({points,route,unresolved:Math.max(0,clients.length-clientPoints.length),uncertain_appointments:uncertainAppointments,geocoded_now:geocodedNow,exact_external_calls:exactCalls,requested_clients:clients.length,located_clients:clientPoints.length}),{headers:{...corsHeaders,'Content-Type':'application/json','Cache-Control':'no-store'}});
  }catch(error){console.error(error);return new Response(JSON.stringify({error:error instanceof Error?error.message:'map_context_failed'}),{status:500,headers:{...corsHeaders,'Content-Type':'application/json'}})}
});
