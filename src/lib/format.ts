// Money and date formatting, as the demo (shared/ui.js).
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function money(n: number | null | undefined, cents?: boolean): string {
  let v = Number(n) || 0;
  const neg = v < 0;
  v = Math.abs(v);
  const c = cents || Math.round(v * 100) % 100 !== 0;
  return (neg ? '-$' : '$') + v.toLocaleString('en-US', { minimumFractionDigits: c ? 2 : 0, maximumFractionDigits: c ? 2 : 0 });
}
export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = iso.slice(0, 10).split('-');
  return MON[+p[1] - 1] + ' ' + +p[2] + ', ' + p[0];
}
export function sd(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = iso.slice(0, 10).split('-');
  return MON[+p[1] - 1] + ' ' + +p[2];
}
export function monthName(iso: string): string {
  const p = iso.split('-');
  return MONTHS[+p[1] - 1] + ' ' + p[0];
}
/** Today as YYYY-MM-DD in the viewer's own time zone. */
export function todayIso(): string {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 864e5);
}
export const round2 = (n: number) => Math.round(n * 100) / 100;
export function sum<T>(a: T[], f: (x: T) => number): number {
  return a.reduce((s, x) => s + (f(x) || 0), 0);
}
export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((x) => x[0]).join('').slice(0, 3).toUpperCase();
}
