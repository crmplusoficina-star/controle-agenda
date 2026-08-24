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

type Candidate = { type: string; priority: 'baixa'|'normal'|'alta'|'critica'; level: number; title: string; message: string; facts: Record<string, unknown> };

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
    const [agendaResp, machineResp, readingResp] = await Promise.all([
      sb.from('appointments').select('id,appointment_date,technician_id,client_name,equipment_serial,service_city,status,service_reason,description').eq('technician_id', appt.technician_id).gte('appointment_date', start).lte('appointment_date', end).order('appointment_date'),
      appt.equipment_serial ? sb.from('g4_machine_summary').select('*').eq('serial', appt.equipment_serial).maybeSingle() : Promise.resolve({ data: null, error: null }),
      appt.equipment_serial ? sb.from('hourmeter_readings').select('appointment_id,hourmeter,reading_date').eq('equipment_serial', appt.equipment_serial).neq('appointment_id', appt.id).lte('reading_date', appt.appointment_date).order('reading_date', { ascending: false }).limit(1) : Promise.resolve({ data: [], error: null }),
    ]);

    const agenda = agendaResp.data || [];
    const machine = machineResp.data as any;
    const previous = (readingResp.data || [])[0] as any;
    const reason = norm(appt.service_reason);
    const city = norm(appt.service_city);
    const isDelivery = reason.includes('ENTREGA TECNICA');
    const candidates: Candidate[] = [];

    if (appt.reported_hourmeter != null && previous?.hourmeter != null) {
      const delta = Number(appt.reported_hourmeter) - Number(previous.hourmeter);
      if (delta >= 400) candidates.push({ type: 'preventivo', priority: delta >= 700 ? 'alta' : 'normal', level: delta >= 700 ? 3 : 2, title: 'Evolução de horímetro', message: `A máquina acumulou aproximadamente ${Math.round(delta)} horas desde a última leitura registrada. Pode valer verificar o planejamento de manutenção.`, facts: { previous: previous.hourmeter, current: appt.reported_hourmeter, delta, previous_date: previous.reading_date } });
    }

    if (city) {
      const nearby = agenda.filter((x: any) => x.id !== appt.id && norm(x.service_city) === city && Math.abs((new Date(x.appointment_date).getTime() - new Date(appt.appointment_date).getTime()) / 86400000) <= 4);
      if (nearby.length >= 2) candidates.push({ type: 'planejamento', priority: 'normal', level: 2, title: 'Permanência na região', message: `O técnico tem vários atendimentos em ${appt.service_city} em poucos dias. Pode valer analisar clientes da região ou oportunidades de rota.`, facts: { city: appt.service_city, appointments_same_city: nearby.length + 1 } });

      const dates = new Set(agenda.map((x: any) => x.appointment_date));
      const before = [...agenda].reverse().find((x: any) => x.appointment_date < appt.appointment_date && norm(x.service_city) === city);
      const after = agenda.find((x: any) => x.appointment_date > appt.appointment_date && norm(x.service_city) === city);
      if (before && after) {
        for (let d = addDays(before.appointment_date, 1); d < after.appointment_date; d = addDays(d, 1)) {
          if (!dates.has(d)) { candidates.push({ type: 'planejamento', priority: 'normal', level: 2, title: 'Dia sem programação na região', message: `Existe um dia sem programação entre atendimentos em ${appt.service_city}. Talvez valha avaliar visita, inspeção, treinamento ou outro uso do período.`, facts: { free_date: d, city: appt.service_city } }); break; }
        }
      }
    }

    if (reason.includes('GAR') && machine?.service_count >= 3 && !isDelivery) {
      candidates.push({ type: 'operacional', priority: 'normal', level: 2, title: 'Contexto de garantia', message: 'A máquina possui histórico de atendimentos e estará em uma visita de garantia. Pode valer revisar o histórico antes da intervenção e considerar uma inspeção visual adicional.', facts: { service_count: machine.service_count, last_service_at: machine.last_service_at, last_operation_type: machine.last_operation_type } });
    }

    let selected = candidates.filter((c) => !isDelivery || c.priority === 'alta' || c.type === 'alerta' || c.type === 'historico');
    if (!selected.length) return json({ result: 'NO_INSIGHT' });
    selected = selected.slice(0, 4);

    let final = selected[0];
    let generatedBy = 'rules';
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (geminiKey) {
      try {
        const model = Deno.env.get('GEMINI_MODEL') || 'gemini-3.7-flash';
        const prompt = `Você é um copiloto de agenda técnica. Analise APENAS os candidatos factuais abaixo. Não invente necessidade de manutenção, falha, proposta, peça ou intenção do cliente. Se nenhum candidato for suficientemente útil, responda exatamente NO_INSIGHT. Caso exista insight útil, devolva JSON puro com candidate_index, title, message, priority e presentation_level. Popup nível 4 é raro. Entrega técnica tem peso baixo. Candidatos: ${JSON.stringify(selected)}`;
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }),
        });
        if (response.ok) {
          const payload = await response.json();
          const text = payload?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('').trim() || '';
          if (text === 'NO_INSIGHT') return json({ result: 'NO_INSIGHT', generated_by: 'gemini' });
          const parsed = JSON.parse(text.replace(/^```json\s*/i, '').replace(/```$/,'').trim());
          const idx = Math.max(0, Math.min(selected.length - 1, Number(parsed.candidate_index) || 0));
          final = { ...selected[idx], title: parsed.title || selected[idx].title, message: parsed.message || selected[idx].message, priority: parsed.priority || selected[idx].priority, level: Number(parsed.presentation_level) || selected[idx].level };
          generatedBy = 'rules+gemini';
        }
      } catch { /* rules are the safe fallback */ }
    }

    const fp = fingerprint([appt.id, final.type, final.title, JSON.stringify(final.facts)]);
    const { data: existing } = await sb.from('ai_insights').select('id,status').eq('fingerprint', fp).maybeSingle();
    if (existing) return json({ result: 'EXISTING', insight_id: existing.id });
    const { data: inserted, error: insertError } = await sb.from('ai_insights').insert({ appointment_id: appt.id, technician_id: appt.technician_id, branch: appt.branch, insight_type: final.type, priority: final.priority, presentation_level: Math.max(1, Math.min(4, final.level)), title: final.title, message: final.message, rationale: final.facts, fingerprint: fp, generated_by: generatedBy, expires_at: `${addDays(appt.appointment_date, 15)}T23:59:59Z` }).select('id').single();
    if (insertError) throw insertError;
    return json({ result: 'INSIGHT', insight_id: inserted.id, generated_by: generatedBy });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } }); }
