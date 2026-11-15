// Call zones from price data (same rules in dashboard/src/lib/zones.ts and stocks/hoodstocks/zones.py — keep in sync).
// Candles: [{ t, o, h, l, c }] oldest → newest. Pure functions, no network.
//
//   ATR(14)            average true range: how far price normally moves per candle
//   swing highs/lows   2-bar pivots (a high above the 2 candles on each side) = resistance / support
//   entry zone         from the nearest support (if within ~1 ATR) up to the current price
//   stop               below that support by ½ ATR, kept between 1 and 3 ATR under price
//   take-profits       the next resistances above price, else 2 / 4 ATR; a runner at the range high
//   hold zone          entry low → first take-profit: hold while price stays above the entry low,
//                      then move the stop to entry once TP1 fills
// Swing levels use daily candles; scalp levels use hourly (or 15-minute) candles.

export function atr(candles, n = 14) {
  if (!candles || candles.length < 2) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const { h, l } = candles[i];
    const pc = candles[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const last = tr.slice(-n).filter((x) => Number.isFinite(x) && x > 0);
  return last.length ? last.reduce((s, x) => s + x, 0) / last.length : null;
}

export function pivots(candles, k = 2) {
  const highs = [];
  const lows = [];
  for (let i = k; i < candles.length - k; i++) {
    const win = candles.slice(i - k, i + k + 1);
    if (candles[i].h >= Math.max(...win.map((x) => x.h))) highs.push(candles[i].h);
    if (candles[i].l <= Math.min(...win.map((x) => x.l))) lows.push(candles[i].l);
  }
  return { highs, lows };
}

// Collapse levels closer than `gap` into one (keeps the first)
function cluster(levels, gap) {
  const out = [];
  for (const x of levels) if (!out.some((y) => Math.abs(y - x) < gap)) out.push(x);
  return out;
}

const rr = (tp, entry, stop) => (entry > stop ? (tp - entry) / (entry - stop) : null);

export function plan(candles, price, { maxStopPct = 0.5, runner = null } = {}) {
  if (!candles || candles.length < 10 || !price) return null;
  const a = atr(candles);
  if (!a) return null;
  const { highs, lows } = pivots(candles);
  const supports = cluster(lows.filter((x) => x < price).sort((x, y) => y - x), a * 0.5);
  const resist = cluster(highs.filter((x) => x > price * 1.002).sort((x, y) => x - y), a * 0.5);
  const sup = supports.find((s) => price - s <= 1.25 * a);
  const entryLow = sup ? Math.max(sup, price - 1.0 * a) : price - 0.5 * a;
  const entryHigh = price;
  let stop = (sup ?? entryLow) - 0.5 * a;
  stop = Math.min(stop, price - 1 * a);
  stop = Math.max(stop, price - 3 * a, price * (1 - maxStopPct));
  const entryMid = (entryLow + entryHigh) / 2;
  const tp1 = resist.find((r) => r >= price + 0.8 * a) ?? price + 2 * a;
  const tp2 = resist.find((r) => r >= tp1 + 0.8 * a) ?? Math.max(tp1 + 1.5 * a, price + 4 * a);
  const rangeHigh = Math.max(...candles.map((x) => x.h));
  let tp3 = runner && runner > tp2 * 1.02 ? runner : rangeHigh > tp2 * 1.02 ? rangeHigh : null;
  const tps = [
    { label: 'TP1', price: tp1, why: resist.includes(tp1) ? 'first resistance' : '2× normal move', sell: 0.33 },
    { label: 'TP2', price: tp2, why: resist.includes(tp2) ? 'next resistance' : '4× normal move', sell: 0.33 },
  ];
  if (tp3) tps.push({ label: 'Runner', price: tp3, why: tp3 === runner ? 'model / milestone target' : 'top of the range', sell: 0.34 });
  for (const t of tps) t.rr = rr(t.price, entryMid, stop);
  return {
    atr: a,
    atrPct: a / price,
    entry: [entryLow, entryHigh],
    stop,
    stopPct: 1 - stop / price,
    hold: [entryLow, tp1],
    tps,
    support: sup ?? null,
    resistances: resist.slice(0, 4),
    basis: sup ? 'support + ATR' : 'ATR only (no nearby support)',
  };
}

// Both plans at once. daily → swing, hourly → scalp. runner: e.g. 2× call price or a model value.
export function zones({ price, daily, hourly, runner = null, maxStopPct = 0.5, at = Date.now() }) {
  const swing = plan(daily, price, { maxStopPct, runner });
  const scalp = plan(hourly, price, { maxStopPct: Math.min(maxStopPct, 0.25) });
  if (scalp) scalp.tps = scalp.tps.filter((t) => t.label !== 'Runner');
  if (!swing && !scalp) return null;
  return { at, price, swing, scalp, note: 'Levels from price data (ATR + swing highs/lows). Speculative — not advice.' };
}

// Compact copy for storage (scorecard, candidates)
export function compactZones(z) {
  if (!z) return null;
  const r = (x) => (x == null ? null : Number(x.toPrecision(5)));
  const p = (pl) => pl && { entry: pl.entry.map(r), stop: r(pl.stop), tps: pl.tps.map((t) => ({ l: t.label, p: r(t.price), rr: t.rr == null ? null : Math.round(t.rr * 10) / 10 })), atr: r(pl.atr) };
  return { at: z.at, swing: p(z.swing), scalp: p(z.scalp) };
}
