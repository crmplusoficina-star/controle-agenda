import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const norm = (v?: string | null) => (v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fingerprint = (parts: unknown[]) => parts.map((x) => norm(String(x ?? ''))).join('|');
const daysSince = (value?: string | null) => value ? Math.floor((Date.now() - new Date(value).getTime()) / 86400000) : 99999;

type Candidate = { type: string; priority: 'baixa'|'normal'|'alta'|'critica'; level: number; title: string; message: string; facts: Record<string, unknown> };
type AgendaRow = { id: string; appointment_date: string; technician_id: string; client_name: string | null; equipment_serial: string | null; service_city: string | null; status: string; service_reason: string | null; description: string | null };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    const serviceKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!serviceKey) throw new Error('Supabase secret key unavailable');
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);
    const { appointment_id } = await req.json();
    if (!appointment_id) return json({ error: 'appointment_id obrigatório' }, 400);

    const { data: appt, error } = await sb.from('appointments').select('*').eq('id', appointment_id).maybeSingle();
    if (error) throw error;
    if (!appt) return json({ error: 'Atendimento não encontrado' }, 404);

    const start = addDays(appt.appointment_date, -7);
    const end = addDays(appt.appointment_date, 14);
    const [agendaResp, machineResp, readingResp, historyResp] = await Promise.all([
      sb.from('appointments').select('id,appointment_date,technician_id,client_name,equipment_serial,service_city,status,service_reason,description').eq('technician_id', appt.technician_id).gte('appointment_date', start).lte('appointment_date', end).order('appointment_date'),
      appt.equipment_serial ? sb.from('g4_machine_summary').select('*').eq('serial', appt.equipment_serial).maybeSingle() : Promise.resolve({ data: null, error: null }),
      appt.equipment_serial ? sb.from('hourmeter_readings').select('appointment_id,hourmeter,reading_date').eq('equipment_serial', appt.equipment_serial).neq('appointment_id', appt.id).lte('reading_date', appt.appointment_date).order('reading_date', { ascending: false }).limit(1) : Promise.resolve({ data: [], error: null }),
      appt.equipment_serial ? sb.from('g4_history_app').select('service_date,operation_type,os_type,description,city').eq('serial', appt.equipment_serial).order('service_date', { ascending: false }).limit(8) : Promise.resolve({ data: [], error: null }),
    ]);

    const agenda = (agendaResp.data || []) as AgendaRow[];
    const machine = machineResp.data as any;
    const previous = (readingResp.data || [])[0] as any;
    const history = (historyResp.data || []) as any[];
    const reason = norm(appt.service_reason);
    const city = norm(appt.service_city);
    const isDelivery = reason.includes('ENTREGA TECNICA');
    const isWarranty = reason.includes('GARANTIA');
    const suppressAll = reason.includes('FERIAS') || reason.includes('FOLGA') || reason.includes('SEM AGENDA');
    const candidates: Candidate[] = [];

    const orderedAgenda = [...agenda].sort((a, b) => a.appointment_date.localeCompare(b.appointment_date));
    const routeSequence = orderedAgenda.filter((item) => item.service_city).map((item) => ({ date: item.appointment_date, city: item.service_city, client: item.client_name, reason: item.service_reason }));
    const routeCities = Array.from(new Set(routeSequence.map((item) => norm(item.city)).filter(Boolean)));

    let staleRouteClients: any[] = [];
    if (routeCities.length && appt.branch) {
      const { data: branchClients } = await sb.from('g4_client_summary').select('client_name,city,last_service_at,machine_count,service_count').eq('branch', appt.branch).limit(1000);
      const scheduledNames = new Set(agenda.map((item) => norm(item.client_name)).filter(Boolean));
      staleRouteClients = (branchClients || []).filter((client: any) => routeCities.includes(norm(client.city)) && !scheduledNames.has(norm(client.client_name)) && daysSince(client.last_service_at) >= 240).sort((a: any, b: any) => daysSince(b.last_service_at) - daysSince(a.last_service_at));
    }

    if (!suppressAll && appt.reported_hourmeter != null && previous?.hourmeter != null) {
      const delta = Number(appt.reported_hourmeter) - Number(previous.hourmeter);
      if (delta >= 400) candidates.push({ type: 'preventivo', priority: delta >= 700 ? 'alta' : 'normal', level: delta >= 700 ? 3 : 2, title: 'Evolução de horímetro', message: `A máquina acumulou aproximadamente ${Math.round(delta)} horas desde a última leitura registrada. Pode valer verificar o planejamento de manutenção.`, facts: { previous: previous.hourmeter, current: appt.reported_hourmeter, delta, previous_date: previous.reading_date } });
    }

    if (!suppressAll && city) {
      const nearby = agenda.filter((x) => x.id !== appt.id && norm(x.service_city) === city && Math.abs((new Date(x.appointment_date).getTime() - new Date(appt.appointment_date).getTime()) / 86400000) <= 4);
      if (nearby.length >= 2) candidates.push({ type: 'planejamento', priority: 'normal', level: 2, title: 'Permanência na região', message: `O técnico tem vários atendimentos em ${appt.service_city} em poucos dias. Pode valer analisar a rota e os clientes da região.`, facts: { city: appt.service_city, appointments_same_city: nearby.length + 1, route_sequence: routeSequence.slice(0, 12) } });
      const dates = new Set(agenda.map((x) => x.appointment_date));
      const before = [...agenda].reverse().find((x) => x.appointment_date < appt.appointment_date && norm(x.service_city) === city);
      const after = agenda.find((x) => x.appointment_date > appt.appointment_date && norm(x.service_city) === city);
      if (before && after) {
        for (let d = addDays(before.appointment_date, 1); d < after.appointment_date; d = addDays(d, 1)) {
          if (!dates.has(d)) { candidates.push({ type: 'planejamento', priority: 'normal', level: 2, title: 'Dia sem programação na região', message: `Existe um dia sem programação entre atendimentos em ${appt.service_city}. Talvez valha avaliar visita, inspeção, treinamento ou outro uso do período.`, facts: { free_date: d, city: appt.service_city, before: before.appointment_date, after: after.appointment_date } }); break; }
        }
      }
    }

    if (!suppressAll && routeSequence.length >= 2 && staleRouteClients.length >= 3) {
      const cityCounts = new Map<string, number>();
      for (const client of staleRouteClients) cityCounts.set(client.city || 'Sem cidade', (cityCounts.get(client.city || 'Sem cidade') || 0) + 1);
      const topCities = Array.from(cityCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
      candidates.push({ type: 'relacionamento', priority: staleRouteClients.length >= 8 ? 'alta' : 'normal', level: staleRouteClients.length >= 8 ? 3 : 2, title: 'Clientes ao longo da agenda', message: `A agenda do técnico passa por regiões com ${staleRouteClients.length} clientes sem atendimento há pelo menos 8 meses. Pode valer visualizar antes de fechar a rota.`, facts: { route_sequence: routeSequence.slice(0, 12), stale_clients_count: staleRouteClients.length, cities: topCities, sample_clients: staleRouteClients.slice(0, 6).map((client) => ({ client: client.client_name, city: client.city, days_without_service: daysSince(client.last_service_at), machines: client.machine_count })) } });
    }

    if (!suppressAll && isWarranty && machine?.service_count >= 3 && !isDelivery) {
      candidates.push({ type: 'operacional', priority: 'normal', level: 2, title: 'Contexto de garantia', message: 'A máquina possui histórico de atendimentos e estará em uma visita de garantia. Pode valer revisar o histórico antes da intervenção e considerar uma inspeção visual adicional.', facts: { service_count: machine.service_count, last_service_at: machine.last_service_at, last_operation_type: machine.last_operation_type, recent_history: history.slice(0, 5) } });
    }

    if (!suppressAll && appt.description && history.length >= 2) {
      candidates.push({ type: 'historico', priority: 'baixa', level: 2, title: 'Histórico disponível para comparação', message: 'Há histórico recente desta máquina que pode ajudar a comparar o atendimento atual antes da visita.', facts: { current_description: appt.description, recent_history: history.slice(0, 6) } });
    }

    let selected = candidates.filter((candidate) => !isDelivery || candidate.priority === 'alta' || candidate.type === 'alerta' || candidate.type === 'historico');
    if (!selected.length) return json({ result: 'NO_INSIGHT', generated_by: 'rules' });
    selected = selected.slice(0, 5);

    let final = selected[0];
    let generatedBy = 'rules';
    const groqKey = Deno.env.get('GROQ_API_KEY');
    if (groqKey) {
      try {
        const model = Deno.env.get('GROQ_MODEL') || 'llama-3.3-70b-versatile';
        const modelContext = { appointment: { date: appt.appointment_date, branch: appt.branch, city: appt.service_city, client: appt.client_name, serial: appt.equipment_serial, reason: appt.service_reason, description: appt.description, hourmeter: appt.reported_hourmeter }, route_sequence: routeSequence.slice(0, 14), machine: machine ? { last_service_at: machine.last_service_at, service_count: machine.service_count, last_operation_type: machine.last_operation_type, last_description: machine.last_description } : null, recent_machine_history: history.slice(0, 6), candidates: selected };
        const systemPrompt = `Você é o copiloto de uma agenda de técnicos de assistência de máquinas. Seu papel é apoiar o consultor, nunca decidir por ele. Analise SOMENTE os fatos fornecidos. Não invente falhas, peças, propostas, necessidade de manutenção, localização ou intenção do cliente. Não transforme tudo em oportunidade comercial. Se nenhum candidato for realmente útil, responda exatamente NO_INSIGHT. Entrega Técnica tem peso baixo. Férias, Folga e Sem agenda não devem gerar oportunidade. Quando houver insight, devolva apenas JSON puro com: candidate_index (inteiro começando em 0), title (curto), message (máximo 2 frases), priority (baixa|normal|alta|critica), presentation_level (1 a 4). Nível 4 é raro e só para alta relevância.`;
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` }, body: JSON.stringify({ model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify(modelContext) }], temperature: 0.1, max_completion_tokens: 420 }) });
        if (response.ok) {
          const payload = await response.json();
          const text = String(payload?.choices?.[0]?.message?.content || '').trim();
          if (text === 'NO_INSIGHT') return json({ result: 'NO_INSIGHT', generated_by: 'groq' });
          const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/,'').trim();
          const parsed = JSON.parse(clean);
          const idx = Math.max(0, Math.min(selected.length - 1, Number(parsed.candidate_index) || 0));
          final = { ...selected[idx], title: String(parsed.title || selected[idx].title).slice(0, 100), message: String(parsed.message || selected[idx].message).slice(0, 500), priority: ['baixa','normal','alta','critica'].includes(parsed.priority) ? parsed.priority : selected[idx].priority, level: Math.max(1, Math.min(4, Number(parsed.presentation_level) || selected[idx].level)) };
          generatedBy = 'rules+groq';
        }
      } catch (groqError) { console.error('groq_fallback_to_rules', groqError); }
    }

    const fp = fingerprint([appt.id, final.type, final.title, JSON.stringify(final.facts)]);
    const { data: existing } = await sb.from('ai_insights').select('id,status').eq('fingerprint', fp).maybeSingle();
    if (existing) return json({ result: 'EXISTING', insight_id: existing.id, generated_by: generatedBy });
    const { data: inserted, error: insertError } = await sb.from('ai_insights').insert({ appointment_id: appt.id, technician_id: appt.technician_id, branch: appt.branch, insight_type: final.type, priority: final.priority, presentation_level: Math.max(1, Math.min(4, final.level)), title: final.title, message: final.message, rationale: final.facts, fingerprint: fp, generated_by: generatedBy, expires_at: `${addDays(appt.appointment_date, 15)}T23:59:59Z` }).select('id').single();
    if (insertError) throw insertError;
    return json({ result: 'INSIGHT', insight_id: inserted.id, generated_by: generatedBy, groq_configured: Boolean(groqKey) });
  } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 500); }
});

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } }); }
