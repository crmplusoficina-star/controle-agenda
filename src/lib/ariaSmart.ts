import { supabase } from './supabase';
import type { AppUser } from '../session';
import type { ArIAReply } from './ariaBrain';

const DAY = 86400000;
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

function fold(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function monthsWithoutService(date: string | null | undefined) {
  if (!date) return 999;
  return Math.max(0, (Date.now() - new Date(date).getTime()) / (DAY * 30.44));
}

function retentionLabel(date: string | null | undefined) {
  const months = monthsWithoutService(date);
  if (months <= 3) return 'até 3 meses';
  if (months <= 6) return '3–6 meses';
  if (months <= 12) return '6–12 meses';
  if (months <= 18) return '12–18 meses';
  return '+18 meses';
}

function requestedCount(message: string, fallback = 3) {
  const found = fold(message).match(/\b(\d{1,2})\s+(?:clientes?|sugestoes?|oportunidades?)/)?.[1];
  return found ? Math.max(1, Math.min(12, Number(found))) : fallback;
}

function cityFromMessage(message: string) {
  const raw = message.replace(/[?!.,]+$/g, '').trim();
  const matches = Array.from(raw.matchAll(/\b(?:em|de)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,45}?)(?=\s+(?:que|com|para|e|ha|há|mais|sem|inativ|essa|esta|na|no|da|do|onde|durante)\b|$|[?!.,])/gi));
  return matches.length ? matches[matches.length - 1][1].trim() : '';
}

function isCityProspectIntent(message: string) {
  const text = fold(message);
  const asksSuggestion = /(sugest|recomend|indiqu|selec|escolh)/.test(text)
    || /clientes?.*(entrar em contato|contatar|contactar|prospect)/.test(text)
    || /(entrar em contato|contatar|contactar|prospect).*(clientes?)/.test(text);
  return asksSuggestion && Boolean(cityFromMessage(message));
}

async function suggestRetentionClientsByCity(message: string): Promise<ArIAReply> {
  const city = cityFromMessage(message);
  const count = requestedCount(message, 3);
  if (!city) return { text: 'Me diga a cidade para eu buscar clientes na Retenção.' };

  const [{ data: rows, error }, { data: openFollowups }] = await Promise.all([
    supabase
      .from('g4_client_city_summary')
      .select('client_key,client_name,branch,city,last_service_at,service_count,machine_count')
      .ilike('city', `%${city}%`)
      .order('last_service_at', { ascending: true })
      .limit(250),
    supabase.from('followups').select('client_name,branch').neq('stage', 'encerrar').limit(1500),
  ]);

  if (error) return { text: `Não consegui consultar a Retenção de ${city} agora.` };

  const open = new Set((openFollowups || []).map((item: any) => `${fold(item.client_name || '')}|${fold(item.branch || '')}`));
  const unique = new Map<string, any>();

  for (const row of rows || []) {
    if (!row.client_name) continue;
    const key = `${fold(row.client_name)}|${fold(row.branch || '')}`;
    if (open.has(key)) continue;
    const current = unique.get(key);
    if (!current || monthsWithoutService(row.last_service_at) > monthsWithoutService(current.last_service_at)) unique.set(key, row);
  }

  const ranked = Array.from(unique.values()).sort((a, b) => {
    const stale = monthsWithoutService(b.last_service_at) - monthsWithoutService(a.last_service_at);
    if (Math.abs(stale) > 0.1) return stale;
    return Number(b.service_count || 0) - Number(a.service_count || 0);
  });

  const top = ranked.slice(0, count);
  if (!top.length) {
    return {
      text: `Consultei a Retenção de ${city}, mas não encontrei clientes livres para sugerir agora. Desconsiderei quem já possui Follow-up aberto.`,
      actions: [{ label: 'Abrir Retenção', view: 'retencao' }],
    };
  }

  const lines = top.map((row, index) => {
    const last = row.last_service_at ? dateFmt.format(new Date(row.last_service_at)) : 'sem data';
    return `${index + 1}. ${row.client_name}\n   ${row.city} · filial ${row.branch} · ${retentionLabel(row.last_service_at)}\n   Último atendimento: ${last} · ${Number(row.service_count || 0)} OS · ${Number(row.machine_count || 0)} máquina(s)`;
  });

  return {
    text: `Consultei a Retenção de ${top[0]?.city || city} e selecionei ${top.length} cliente(s) para você avaliar para Follow-up. Priorizei maior tempo sem atendimento e histórico de atendimento, e deixei de fora quem já tem tratativa aberta.\n\n${lines.join('\n\n')}\n\nEsses clientes ainda não foram adicionados ao Follow-up; são sugestões para sua decisão.`,
    actions: [
      { label: 'Abrir Retenção', view: 'retencao' },
      { label: 'Ver no mapa', view: 'retencao', mode: 'map' },
      { label: 'Abrir Follow-up', view: 'followup', tab: 'active' },
    ],
  };
}

type LocalLearning = {
  original_question: string;
  original_answer: string;
  correction: string;
  normalized_question: string;
  created_by_matricula: string;
  created_by_name: string;
  created_at: string;
};

const LEARNING_KEY = 'aria-learning-v1';

function saveLocalLearning(row: LocalLearning) {
  try {
    const current = JSON.parse(localStorage.getItem(LEARNING_KEY) || '[]') as LocalLearning[];
    const next = [row, ...current].slice(0, 100);
    localStorage.setItem(LEARNING_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export async function learnCorrectionResilient(originalQuestion: string, originalAnswer: string, correction: string, user: AppUser) {
  const row: LocalLearning = {
    original_question: originalQuestion,
    original_answer: originalAnswer,
    correction,
    normalized_question: fold(originalQuestion),
    created_by_matricula: String(user.matricula),
    created_by_name: user.name,
    created_at: new Date().toISOString(),
  };

  const localSaved = saveLocalLearning(row);
  const { error } = await supabase.from('aria_learning').insert({
    original_question: row.original_question,
    original_answer: row.original_answer,
    correction: row.correction,
    normalized_question: row.normalized_question,
    created_by_matricula: row.created_by_matricula,
    created_by_name: row.created_by_name,
  });

  return { localSaved, sharedSaved: !error };
}

export async function answerSmartArIA(message: string): Promise<ArIAReply | null> {
  if (isCityProspectIntent(message)) return suggestRetentionClientsByCity(message);
  return null;
}
