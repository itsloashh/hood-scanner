export const TZ = 'America/Toronto';

export function usd(n: number | null | undefined, digits?: number) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return `$${n.toFixed(digits ?? 2)}`;
}

export function price(n: number | null | undefined) {
  if (n == null || !isFinite(n) || n === 0) return '—';
  if (n >= 1) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (n >= 0.001) return `$${Number(n.toPrecision(4))}`;
  // tiny prices: $0.0₅4828 = 0.000004828 (subscript = number of zeros after the point)
  const zeros = Math.ceil(-Math.log10(n)) - 1;
  if (zeros <= 3) return `$${Number(n.toPrecision(4))}`;
  const digits = Math.round(n * 10 ** (zeros + 4)).toString().slice(0, 4);
  const sub = String(zeros).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]).join('');
  return `$0.0${sub}${digits}`;
}

export const x = (v: number | null | undefined) => (v == null || !isFinite(v) ? '—' : `${v >= 10 ? v.toFixed(0) : v.toFixed(2)}×`);
export const pct = (v: number | null | undefined, digits = 0) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`);
export const signedPct = (v: number | null | undefined) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

export function date(ms: number | null | undefined, withTime = true) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-CA', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}

export function ago(ms: number | null | undefined, now = Date.now()) {
  if (!ms) return '—';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
