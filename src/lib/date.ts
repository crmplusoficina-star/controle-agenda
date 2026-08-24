export function isoDate(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseIso(value: string) {
  return new Date(`${value}T12:00:00`);
}

export function startOfWeek(input = new Date()) {
  const date = new Date(input);
  const day = date.getDay();
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  date.setHours(12, 0, 0, 0);
  return date;
}

export function addDays(input: Date, days: number) {
  const date = new Date(input);
  date.setDate(date.getDate() + days);
  return date;
}

export function daysBetween(a: string, b = isoDate(new Date())) {
  const one = parseIso(a).getTime();
  const two = parseIso(b).getTime();
  return Math.max(0, Math.floor((two - one) / 86400000));
}
