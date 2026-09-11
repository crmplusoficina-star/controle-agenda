import { createClient } from '@supabase/supabase-js';
import type { AppointmentDraft } from '../drafts';
import type { MachineSummary } from '../types';
import type { CommercialInsight } from './commercialInsights';

const agendaAi = createClient(
  'https://lwowtuspbrnbaukakyss.supabase.co',
  'sb_publishable_ZYYWM9lamdDpgiTMS4en9g_s-k2W9RN',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function scoreFromConfidence(confidence: number, hourmeter: number, serviceCount: number, source: string) {
  let score = source === 'groq' ? 6 : 4;
  if (confidence >= 0.75) score += 2;
  else if (confidence >= 0.6) score += 1;
  if (hourmeter >= 8000) score += 1;
  if (hourmeter >= 12000) score += 1;
  if (serviceCount >= 2) score += 1;
  return score;
}

function potential(score: number): CommercialInsight['potential'] {
  if (score >= 11) return 'Muito alto';
  if (score >= 8) return 'Alto';
  return 'Médio';
}

export async function buildSemanticCommercialInsight(
  draft: AppointmentDraft,
  machineContext: MachineSummary | null,
): Promise<CommercialInsight | null> {
  if (draft.description.trim().length < 4) return null;

  const hourmeter = Number(draft.reported_hourmeter || 0);
  const { data, error } = await agendaAi.functions.invoke('aria-commercial-insight', {
    body: {
      service_reason: draft.service_reason,
      description: draft.description,
      hourmeter: Number.isFinite(hourmeter) ? hourmeter : 0,
      serial: draft.equipment_serial || null,
      service_count: machineContext?.service_count || 0,
      last_operation_type: machineContext?.last_operation_type || null,
    },
  });

  if (error || !data?.useful) return null;

  const confidence = Number(data.confidence || 0);
  const score = scoreFromConfidence(
    confidence,
    Number.isFinite(hourmeter) ? hourmeter : 0,
    machineContext?.service_count || 0,
    String(data.source || ''),
  );

  if (score < 5) return null;

  return {
    title: String(data.title || 'Oportunidade identificada pela ArIA'),
    message: String(data.message || ''),
    potential: potential(score),
    score,
    kind: `semantic:${String(data.category || 'other')}`,
  };
}
