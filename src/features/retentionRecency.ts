import { daysBetween } from '../lib/date';

export type RecencyBucket = '0-3' | '3-6' | '6-12' | '12-18' | '18+';

export const retentionRecency = [
  { key: '0-3' as const, label: 'até 3 meses', color: '#16a34a' },
  { key: '3-6' as const, label: '3–6 meses', color: '#f59e0b' },
  { key: '6-12' as const, label: '6–12 meses', color: '#dc2626' },
  { key: '12-18' as const, label: '12–18 meses', color: '#7c3aed' },
  { key: '18+' as const, label: '+18 meses', color: '#475569' },
];

export function recencyBucket(lastServiceAt?: string | null): RecencyBucket {
  if (!lastServiceAt) return '18+';
  const days = Math.max(0, daysBetween(lastServiceAt.slice(0, 10)));
  if (days <= 92) return '0-3';
  if (days <= 184) return '3-6';
  if (days <= 366) return '6-12';
  if (days <= 550) return '12-18';
  return '18+';
}

export function recencyColor(lastServiceAt?: string | null) {
  const bucket = recencyBucket(lastServiceAt);
  return retentionRecency.find((item) => item.key === bucket)?.color || '#475569';
}
