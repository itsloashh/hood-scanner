// Scores a coin that already passed the junk filter, 0–100.
// Thesis: "survivor rebound" — a 3+ week old coin that already crashed, whose
// community held, whose price stopped making new lows, and where buyers are
// starting to come back.
//
//   Community      25  holders, unique buyers, socials, Telegram size, GT trust/votes
//   Conviction     10  holders flat/rising while price fell
//   Distribution   15  spread across real wallets
//   Structure      25  deep drawdown, sideways base, lows holding
//   Awakening      15  volume + buyers picking up, not already ripping
//   Liquidity       5  depth relative to market cap
//   Narrative       5  rotation from a moving cluster leader, stock-paired

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// linear map v from [a,b] → [0,pts] (works for a > b too)
const lerp = (v, a, b, pts) => (v == null || Number.isNaN(v) ? 0 : clamp((v - a) / (b - a), 0, 1) * pts);

export function chartFeatures(candles, priceNow) {
  if (!candles?.length) return null;
  const ath = Math.max(...candles.map((c) => c.h));
  const price = priceNow ?? candles.at(-1).c;
  const drawdownPct = ath > 0 ? (1 - price / ath) * 100 : null;

  const last7 = candles.slice(-7);
  const closes7 = last7.map((c) => c.c).filter((c) => c > 0);
  const baseRange = closes7.length >= 5 ? Math.max(...closes7) / Math.min(...closes7) : null;

  // Lows holding: the lowest low of the last 5 days is above the lowest low before that.
  const recent = candles.slice(-5);
  const prior = candles.slice(0, -5);
  const lowsHolding =
    prior.length >= 5 ? Math.min(...recent.map((c) => c.l)) >= Math.min(...prior.map((c) => c.l)) : null;

  const prev7 = candles.slice(-8, -1);
  const avgVol7 = prev7.length ? prev7.reduce((s, c) => s + c.v, 0) / prev7.length : null;
  const firstCandleAt = candles[0].t;

  return { ath, drawdownPct, baseRange, lowsHolding, avgVol7, firstCandleAt };
}

// Holder trend from our own history: % change over the last ~3 days of samples.
export function holderTrend(history, holdersNow, now = Date.now()) {
  if (!history?.length || holdersNow == null) return null;
  const target = now - 3 * 86_400_000;
  let ref = history[0];
  for (const s of history) if (s[0] <= target) ref = s;
  if (!ref || ref[1] <= 0 || now - ref[0] < 12 * 3_600_000) return null; // need ≥12h of history
  return ((holdersNow - ref[1]) / ref[1]) * 100;
}

export function scoreCoin({ pool, holdersCount, conc, socials, chart, holderChangePct, rotation, stockPaired, community }) {
  const parts = {};

  // Community (25): on-chain crowd + off-chain crowd
  let comm =
    lerp(holdersCount, 150, 1500, 9) + // holders
    lerp(pool.buyers24h, 8, 100, 5) + // real unique buyers today
    Math.min(socials, 3); // linked X / TG / site (max 3)
  comm += lerp(community?.tgMembers, 100, 2000, 4); // Telegram group size
  const gt = community?.gtScore;
  comm += lerp(gt, 30, 80, 2); // GeckoTerminal trust score
  const sp = community?.sentimentPos;
  if (sp != null) comm += sp >= 70 ? 2 : sp >= 50 ? 1 : 0; // community votes
  if (community?.xShared > 0) comm -= 3; // recycled X handle
  comm -= Math.min(3, (community?.susReports || 0) * 1.5);
  parts.community = clamp(comm, 0, 25);

  // Conviction: holders held through the drawdown
  if (holderChangePct == null) parts.conviction = 5;
  else if (holderChangePct >= 2) parts.conviction = 10;
  else if (holderChangePct >= -2) parts.conviction = 7;
  else if (holderChangePct >= -5) parts.conviction = 3;
  else parts.conviction = 0;

  parts.distribution = conc ? lerp(conc.top10Pct, 35, 10, 10) + lerp(conc.top1Pct, 8, 2, 5) : 0;

  let structure = 0;
  if (chart) {
    const dd = chart.drawdownPct;
    if (dd != null) {
      if (dd >= 65 && dd <= 92) structure += 10;
      else if (dd >= 50 && dd < 65) structure += 6;
      else if (dd > 92 && dd <= 97) structure += 4;
    }
    structure += lerp(chart.baseRange, 1.8, 1.15, 8);
    if (chart.lowsHolding === true) structure += 7;
  }
  parts.structure = structure;

  let awakening = 0;
  const volRatio = chart?.avgVol7 ? pool.volume24h / chart.avgVol7 : null;
  awakening += lerp(volRatio, 1, 3, 8);
  const bs = pool.sellers24h > 0 ? pool.buyers24h / pool.sellers24h : null;
  if (bs != null && bs >= 1.1 && bs <= 3) awakening += 4;
  const ch = pool.change.h24 ?? 0;
  if (ch >= -5 && ch <= 40) awakening += 3;
  parts.awakening = awakening;

  const liqRatio = pool.marketCap ? (pool.liquidityUsd ?? 0) / pool.marketCap : 0;
  parts.liquidity = lerp(liqRatio, 0.05, 0.2, 5);

  parts.narrative = (rotation?.active ? 3 : 0) + (stockPaired ? 2 : 0);

  const total = Math.round(Object.values(parts).reduce((s, v) => s + v, 0));
  return {
    total: clamp(total, 0, 100),
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    volRatio,
    buySellRatio: bs,
    liqRatio,
  };
}

// Market regime from total scanned volume vs. its recent median.
export function regime(history, volumeNow) {
  const vals = history.map((h) => h.v).filter((v) => v > 0);
  if (vals.length < 6) return { state: 'neutral', ratio: null };
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const ratio = volumeNow / median;
  return { state: ratio >= 1.15 ? 'risk-on' : ratio <= 0.8 ? 'risk-off' : 'neutral', ratio };
}
