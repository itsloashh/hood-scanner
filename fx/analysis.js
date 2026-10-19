// FX analysis — market structure, key levels and a driver-based directional lean.
// This is CONTEXT for Logan's own strategy, not a trade signal: every lean lists its reasons.
import { FX } from './config.js';

const DAY = 86_400_000;
const last = (a) => a[a.length - 1];
const sma = (closes, n) => (closes.length >= n ? closes.slice(-n).reduce((s, x) => s + x, 0) / n : null);
export const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);

export function atr(c, n = FX.structure.atrPeriod) {
  if (c.length < n + 1) return null;
  const tr = [];
  for (let i = c.length - n; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  return tr.reduce((s, x) => s + x, 0) / n;
}

// Swing points: a high with `k` lower highs each side (and the mirror for lows)
export function swings(c, k = FX.structure.swingLookback) {
  const highs = [];
  const lows = [];
  for (let i = k; i < c.length - k; i++) {
    const win = c.slice(i - k, i + k + 1);
    if (win.every((x, j) => j === k || x.h < c[i].h)) highs.push({ i, t: c[i].t, p: c[i].h });
    if (win.every((x, j) => j === k || x.l > c[i].l)) lows.push({ i, t: c[i].t, p: c[i].l });
  }
  return { highs, lows };
}

// Trend from the last two swing highs/lows + the latest break of structure
export function structure(c) {
  if (!c?.length) return null;
  const { highs, lows } = swings(c);
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  let trend = 'range';
  if (h1 && h2 && l1 && l2) {
    if (h2.p > h1.p && l2.p > l1.p) trend = 'up';
    else if (h2.p < h1.p && l2.p < l1.p) trend = 'down';
  }
  const price = last(c).c;
  // break of structure: price now beyond the most recent swing point
  let bos = null;
  if (h2 && price > h2.p) bos = { dir: 'up', level: h2.p, t: h2.t };
  else if (l2 && price < l2.p) bos = { dir: 'down', level: l2.p, t: l2.t };
  const words = { up: 'higher highs + higher lows', down: 'lower highs + lower lows', range: 'no clear sequence (ranging)' };
  return { trend, describe: words[trend], lastHigh: h2?.p ?? null, lastLow: l2?.p ?? null, bos, price };
}

// Key levels from daily candles: previous day, previous week, moving averages
export function levels(daily) {
  if (daily.length < 3) return null;
  const prevDay = daily[daily.length - 2];
  // previous calendar week (Mon–Fri) in UTC
  const weekStart = (t) => {
    const d = new Date(t);
    const wd = (d.getUTCDay() + 6) % 7; // Mon = 0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - wd);
  };
  const thisWeek = weekStart(last(daily).t);
  const prevWeekBars = daily.filter((k) => weekStart(k.t) === thisWeek - 7 * DAY);
  const closes = daily.map((k) => k.c);
  return {
    prevDayHigh: prevDay.h, prevDayLow: prevDay.l,
    prevWeekHigh: prevWeekBars.length ? Math.max(...prevWeekBars.map((k) => k.h)) : null,
    prevWeekLow: prevWeekBars.length ? Math.min(...prevWeekBars.map((k) => k.l)) : null,
    sma20: sma(closes, 20), sma50: sma(closes, 50), sma200: sma(closes, 200),
    atr: atr(daily),
  };
}

// A driver's move: today vs yesterday's close, and over 5 sessions
export function driverMove(daily) {
  if (!daily?.length || daily.length < 6) return null;
  const now = last(daily).c;
  return { price: now, d1: pct(now, daily[daily.length - 2].c), d5: pct(now, daily[daily.length - 6].c) };
}

// Directional lean: every factor is +1 / −1 (×weight) with a plain-English reason
// A FRED rate series' move in basis points: today vs previous, and over ~5 sessions
export function macroMove(series) {
  if (!series?.length || series.length < 6) return null;
  const v = last(series).v;
  return { v, d1bp: (v - series[series.length - 2].v) * 100, d5bp: (v - series[series.length - 6].v) * 100, asOf: last(series).t };
}

export function bias(pairKey, { daily, hourly, drivers = {}, macro = {}, cot = null }) {
  const P = FX.pairs[pairKey];
  const f = [];
  const add = (dir, weight, why) => dir && f.push({ dir: Math.sign(dir), weight, why });
  const ds = structure(daily);
  const hs = structure(hourly);
  const lv = levels(daily);
  const price = last(hourly?.length ? hourly : daily)?.c;

  if (ds) add(ds.trend === 'up' ? 1 : ds.trend === 'down' ? -1 : 0, 2, `Daily structure: ${ds.describe}`);
  if (ds?.bos) add(ds.bos.dir === 'up' ? 1 : -1, 1, `Daily break of structure ${ds.bos.dir === 'up' ? 'above' : 'below'} ${fmt(pairKey, ds.bos.level)}`);
  if (hs) add(hs.trend === 'up' ? 1 : hs.trend === 'down' ? -1 : 0, 1, `Hourly structure: ${hs.describe}`);
  if (lv?.sma50 && price) add(price > lv.sma50 ? 1 : -1, 1, `Price ${price > lv.sma50 ? 'above' : 'below'} the 50-day average (${fmt(pairKey, lv.sma50)})`);
  if (lv?.sma200 && price) add(price > lv.sma200 ? 1 : -1, 1, `Price ${price > lv.sma200 ? 'above' : 'below'} the 200-day average (${fmt(pairKey, lv.sma200)})`);

  for (const [key, sign] of Object.entries(P.drivers)) {
    const m = drivers[key];
    if (!sign || !m || m.d5 == null) continue;
    const meaningful = Math.abs(m.d5) >= FX.drivers[key].shockPct / 3;
    if (!meaningful) continue;
    const dir = Math.sign(m.d5) * sign;
    add(dir, 1, `${FX.drivers[key].name} ${m.d5 >= 0 ? 'up' : 'down'} ${Math.abs(m.d5).toFixed(1)}% this week → usually ${dir > 0 ? 'supports' : 'weighs on'} ${P.name}`);
  }

  for (const [key, sign] of Object.entries(P.macro || {})) {
    const m = macro[key];
    const M = FX.macro[key];
    if (!sign || !m || m.d5bp == null || Math.abs(m.d5bp) < M.shockBp / 2) continue;
    const dir = Math.sign(m.d5bp) * sign;
    add(dir, 1, `${M.name} ${m.d5bp >= 0 ? 'up' : 'down'} ${Math.abs(m.d5bp).toFixed(0)} bp this week (now ${m.v.toFixed(2)}%) → usually ${dir > 0 ? 'supports' : 'weighs on'} ${P.name}`);
  }

  if (cot?.length >= 2) {
    // gold: specs long gold = bullish; CAD/JPY: specs net CAD minus net JPY
    const change = cot[0].net - cot[1].net;
    add(Math.sign(change), 1, `Big speculators ${change >= 0 ? 'added' : 'cut'} net longs last week (CFTC, ${cot[0].date})`);
  }

  const score = f.reduce((s, x) => s + x.dir * x.weight, 0);
  const max = f.reduce((s, x) => s + x.weight, 0) || 1;
  const label = score >= 3 ? 'Bullish lean' : score <= -3 ? 'Bearish lean' : 'Mixed / no clear lean';
  return { label, score, max, strength: Math.abs(score) / max, factors: f, daily: ds, hourly: hs, levels: lv, price };
}

export const fmt = (pairKey, v) => (v == null ? '—' : Number(v).toFixed(FX.pairs[pairKey]?.decimals ?? 2));

// Combine CAD and JPY speculator positioning into a CAD/JPY view (net CAD − net JPY)
export function cadjpyCot(cad, jpy) {
  if (!cad?.length || !jpy?.length) return null;
  const n = Math.min(cad.length, jpy.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push({ date: cad[i].date, net: cad[i].net - jpy[i].net, cad: cad[i].net, jpy: jpy[i].net });
  return out;
}
