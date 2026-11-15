// Same rules as src/zones.js (coins) and stocks/hoodstocks/zones.py — keep in sync.
// ATR(14) + 2-bar swing highs/lows → entry zone, stop, hold zone, take-profits. Speculative, from price data only.
export type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number };
export type TP = { label: string; price: number; rr: number | null; why?: string };
export type Plan = { atr: number; entry: [number, number]; stop: number; hold: [number, number]; tps: TP[]; support: number | null; resistances: number[]; basis: string };

export function atr(c: Candle[], n = 14) {
  if (!c || c.length < 2) return null;
  const tr: number[] = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  const last = tr.slice(-n).filter((x) => Number.isFinite(x) && x > 0);
  return last.length ? last.reduce((s, x) => s + x, 0) / last.length : null;
}

function pivots(c: Candle[], k = 2) {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = k; i < c.length - k; i++) {
    const w = c.slice(i - k, i + k + 1);
    if (c[i].h >= Math.max(...w.map((x) => x.h))) highs.push(c[i].h);
    if (c[i].l <= Math.min(...w.map((x) => x.l))) lows.push(c[i].l);
  }
  return { highs, lows };
}

const cluster = (xs: number[], gap: number) => xs.reduce<number[]>((o, x) => (o.some((y) => Math.abs(y - x) < gap) ? o : [...o, x]), []);

export function plan(c: Candle[] | null | undefined, price: number, { maxStopPct = 0.5, runner = null as number | null, scalp = false } = {}): Plan | null {
  if (!c || c.length < 10 || !price) return null;
  const a = atr(c);
  if (!a) return null;
  const { highs, lows } = pivots(c);
  const supports = cluster(lows.filter((x) => x < price).sort((x, y) => y - x), a * 0.5);
  const resist = cluster(highs.filter((x) => x > price * 1.002).sort((x, y) => x - y), a * 0.5);
  const sup = supports.find((s) => price - s <= 1.25 * a) ?? null;
  const entryLow = sup != null ? Math.max(sup, price - a) : price - 0.5 * a;
  let stop = (sup ?? entryLow) - 0.5 * a;
  stop = Math.min(stop, price - a);
  stop = Math.max(stop, price - 3 * a, price * (1 - maxStopPct));
  const mid = (entryLow + price) / 2;
  const tp1 = resist.find((r) => r >= price + 0.8 * a) ?? price + 2 * a;
  const tp2 = resist.find((r) => r >= tp1 + 0.8 * a) ?? Math.max(tp1 + 1.5 * a, price + 4 * a);
  const hi = Math.max(...c.map((x) => x.h));
  const tp3 = runner && runner > tp2 * 1.02 ? runner : hi > tp2 * 1.02 ? hi : null;
  const rr = (p: number) => (mid > stop ? (p - mid) / (mid - stop) : null);
  const tps: TP[] = [
    { label: 'TP1', price: tp1, rr: rr(tp1), why: resist.includes(tp1) ? 'first resistance' : '2× normal move' },
    { label: 'TP2', price: tp2, rr: rr(tp2), why: resist.includes(tp2) ? 'next resistance' : '4× normal move' },
  ];
  if (tp3 && !scalp) tps.push({ label: 'Runner', price: tp3, rr: rr(tp3), why: tp3 === runner ? 'target' : 'top of range' });
  return { atr: a, entry: [entryLow, price], stop, hold: [entryLow, tp1], tps, support: sup, resistances: resist.slice(0, 4), basis: sup != null ? 'support + ATR' : 'ATR only' };
}

// Stored call zones come compact ({entry, stop, tps:[{l,p,rr}]}) from the coin bot, or full from the stock engine
export type StoredPlan = { entry: number[]; stop: number; tps: { l?: string; label?: string; p?: number; price?: number; rr: number | null }[] } | null;
export function normalize(p: StoredPlan | undefined): Plan | null {
  if (!p) return null;
  const tps = p.tps.map((t) => ({ label: (t.l ?? t.label) as string, price: (t.p ?? t.price) as number, rr: t.rr }));
  return { atr: 0, entry: [p.entry[0], p.entry[1]], stop: p.stop, hold: [p.entry[0], tps[0]?.price ?? p.entry[1]], tps, support: null, resistances: [], basis: 'at call' };
}
