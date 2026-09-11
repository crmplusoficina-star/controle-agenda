import type { CommercialInsight } from './commercialInsights';
import type { AppointmentDraft } from '../drafts';

function fold(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type SemanticRule = {
  key: string;
  pattern: RegExp;
  title: string;
  suggestion: string;
  potential: CommercialInsight['potential'];
  baseScore: number;
  requireContext?: boolean;
};

const rules: SemanticRule[] = [
  {
    key: 'hvac_no_cooling',
    pattern: /(ar condicionado|ar|a c).*(nao gela|nao esta gelando|parou de gelar|sem gelar|fraco|quente)|(?:nao gela|parou de gelar|sem gelar).*(ar condicionado|ar|a c)/,
    title: 'Oportunidade identificada: Climatização / cabine',
    suggestion: 'O atendimento atual é claramente relacionado ao sistema de climatização. Se houver reincidência, componentes já substituídos ou outras necessidades de cabine no histórico, pode valer estruturar uma abordagem mais completa em vez de tratar somente a ocorrência isolada.',
    potential: 'Alto',
    baseScore: 5,
    requireContext: true,
  },
  {
    key: 'electrical_no_start',
    pattern: /(nao pega|nao liga|nao da partida|tec tec|partida fraca)/,
    title: 'Oportunidade identificada: Sistema elétrico / partida',
    suggestion: 'A descrição aponta para sistema de partida/elétrica. Só vale transformar em oportunidade comercial se houver recorrência, bateria/alternador/partida já atendidos ou outro padrão relacionado no histórico.',
    potential: 'Alto',
    baseScore: 4,
    requireContext: true,
  },
  {
    key: 'cooling_overheat',
    pattern: /(aquecendo|superaquec|temperatura alta|fervendo|jogando agua|baixando agua)/,
    title: 'Oportunidade identificada: Arrefecimento',
    suggestion: 'Há ocorrência ligada ao arrefecimento. Se o histórico mostrar reincidência, intervenções anteriores no mesmo sistema ou alto impacto operacional, pode existir oportunidade de uma solução mais ampla.',
    potential: 'Alto',
    baseScore: 5,
    requireContext: true,
  },
  {
    key: 'power_loss',
    pattern: /(sem forca|perdeu forca|perdendo forca|amarrad|nao desenvolve|fraca sob carga)/,
    title: 'Oportunidade identificada: Desempenho / powertrain',
    suggestion: 'O relato indica perda de desempenho. A ArIA só deve elevar isso a oportunidade comercial quando houver histórico relacionado de motor, transmissão, hidráulico ou recorrência do mesmo sintoma.',
    potential: 'Alto',
    baseScore: 4,
    requireContext: true,
  },
];

function matchingRule(draft: AppointmentDraft) {
  const text = fold(`${draft.service_reason || ''} ${draft.description || ''}`);
  return rules.find((rule) => rule.pattern.test(text)) || null;
}

export function semanticCommercialHint(
  draft: AppointmentDraft,
  context: { relatedHistoryCount: number; clientMachineCount: number; hourmeter: number; majorSystems24m: number },
): CommercialInsight | null {
  const rule = matchingRule(draft);
  if (!rule) return null;

  let score = rule.baseScore;
  if (context.relatedHistoryCount >= 1) score += 3;
  if (context.relatedHistoryCount >= 2) score += 2;
  if (context.hourmeter >= 12000) score += 1;
  if (context.majorSystems24m >= 2) score += 2;
  if (context.clientMachineCount >= 5) score += 1;

  if (rule.requireContext && score < 8) return null;

  return {
    title: rule.title,
    message: rule.suggestion,
    potential: score >= 11 ? 'Muito alto' : rule.potential,
    score,
    kind: `semantic:${rule.key}`,
  };
}
