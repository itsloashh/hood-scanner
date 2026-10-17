// Junk filter. Stage 1 uses only the pool list (cheap). Stage 2 runs after
// holder + token info calls. Any failed check rejects the coin; the reason
// labels are stable so the bot can count *why* coins get cut (the funnel).
import { CONFIG } from '../config.js';

const DAY = 86_400_000;

export function ageDays(createdAt, now = Date.now()) {
  if (!createdAt) return null;
  return (now - new Date(createdAt).getTime()) / DAY;
}

export function quickFilter(pool, now = Date.now()) {
  const c = CONFIG;
  const reasons = [];
  const age = ageDays(pool.createdAt, now);
  if (pool.marketCap == null) reasons.push('no market cap');
  else if (pool.marketCap > c.maxMarketCap) reasons.push('mcap over max');
  else if (pool.marketCap < c.minMarketCap) reasons.push('mcap under min (dead)');
  const lane = laneOf(pool.marketCap);
  if ((pool.liquidityUsd ?? 0) < c.minLiquidityUsd) reasons.push('liquidity too thin');
  else if (lane === 'quality' && (pool.liquidityUsd ?? 0) < c.lanes.quality.minLiquidityUsd) reasons.push('quality lane: liquidity under $100k');
  if (age == null || age < c.minAgeDays) reasons.push(`younger than ${c.minAgeDays}d`);
  if (pool.buyers24h < c.community.minBuyers24h) reasons.push('too few buyers 24h');
  if (pool.sellers24h < c.community.minSellers24h) reasons.push('almost no sellers (honeypot risk)');
  if ((pool.change.h24 ?? 0) > c.maxChange24hPct) reasons.push('already pumping');
  if ((pool.susReports || 0) > c.community.maxSusReports) reasons.push('flagged suspicious on GeckoTerminal');
  return { ok: reasons.length === 0, reasons, ageDays: age, lane };
}

// MICRO ($5k–$333k) or QUALITY ($333k–$25M)
export function laneOf(mcap) {
  if (mcap == null) return 'micro';
  return mcap > CONFIG.lanes.microMaxMarketCap ? 'quality' : 'micro';
}

// Quality lane only, once the chart is in: the coin must have actually crashed and be basing
export function laneChartCheck(lane, chart) {
  if (lane !== 'quality' || !chart || chart.drawdownPct == null) return null;
  const q = CONFIG.lanes.quality;
  if (chart.drawdownPct < q.minDrawdownPct) return `quality lane: only ${Math.round(chart.drawdownPct)}% off its high (want ${q.minDrawdownPct}–${q.maxDrawdownPct}%)`;
  if (chart.drawdownPct > q.maxDrawdownPct) return `quality lane: ${Math.round(chart.drawdownPct)}% off its high — too broken (want ${q.minDrawdownPct}–${q.maxDrawdownPct}%)`;
  return null;
}

// Copycat: a coin using the ticker of an established coin, from a different contract.
// known = { SYMBOL: [address, …] } for tickers held by 5k+ wallets (plus CONFIG.knownCoins).
export const normSymbol = (s) => String(s || '').replace(/^\$/, '').replace(/\s+/g, '').toUpperCase();
export function copycatOf(pool, known) {
  const sym = normSymbol(pool.baseToken.symbol);
  const real = known[sym];
  if (!real?.length || real.includes(pool.baseToken.address)) return null;
  return `copycat of $${sym} (the real one is ${real[0].slice(0, 6)}…${real[0].slice(-4)})`;
}

export function buildKnownTickers(tickerState = {}) {
  const known = {};
  for (const [sym, addrs] of Object.entries(tickerState)) known[normSymbol(sym)] = [...addrs];
  for (const [sym, addr] of Object.entries(CONFIG.knownCoins)) {
    const k = normSymbol(sym);
    known[k] = [addr.toLowerCase(), ...(known[k] || []).filter((a) => a !== addr.toLowerCase())];
  }
  return known;
}

export function deepFilter({ info, holdersCount, conc, community, lane = 'micro', marketCap = null }) {
  const c = CONFIG;
  const reasons = [];
  const warnings = [...(community?.flags || [])];

  if (info?.isHoneypot === true || info?.isHoneypot === 'yes') reasons.push('flagged honeypot');

  if (holdersCount == null) reasons.push('holder count unavailable');
  else if (holdersCount < c.community.minHolders) reasons.push('too few holders');
  else if (lane === 'quality') {
    if (holdersCount < c.lanes.quality.minHolders) reasons.push('quality lane: under 5,000 holders');
    else if (marketCap != null && marketCap / holdersCount < c.lanes.quality.minUsdPerHolder) reasons.push('quality lane: holder count padded (under $10 of market cap per holder)');
  }

  const socials = countSocials(info);
  if (c.community.requireSocial && socials === 0) reasons.push('no socials linked');

  if (!conc) {
    reasons.push('holder distribution unavailable');
  } else {
    if (conc.source === 'estimate') warnings.push('holder split estimated from GeckoTerminal — top wallet not checked');
    if (conc.top1Pct != null && conc.top1Pct > c.distribution.maxTop1Pct) reasons.push('top wallet too big');
    if (conc.top10Pct > c.distribution.maxTop10Pct) reasons.push('top 10 wallets too concentrated');
    if (conc.largestContractPct > 25) warnings.push(`a non-pool contract holds ${conc.largestContractPct.toFixed(0)}% (locker or team vault?)`);
  }

  const devPct = conc?.devPctOnchain ?? info?.devPct;
  if (devPct != null && devPct > c.distribution.maxDevPct) reasons.push('dev holds too much');
  if (info && info.devPct == null && conc?.devPctOnchain == null) warnings.push('dev wallet unknown');

  return { ok: reasons.length === 0, reasons, warnings, socials };
}

export function countSocials(info) {
  if (!info) return 0;
  return (info.twitter ? 1 : 0) + (info.telegram ? 1 : 0) + (info.websites?.length ? 1 : 0) + (info.discord ? 1 : 0);
}

// Pumping coins: judge them on where they were BEFORE the pump (pre-pump market cap),
// with every other rule the same. Returns ok + the pre-pump numbers.
export function pumpFilter(pool, now = Date.now()) {
  const ch = pool.change.h24 ?? 0;
  if (ch < CONFIG.pump.minChangePct) return { ok: false, reasons: ['not pumping'] };
  const baseMcap = pool.marketCap != null ? pool.marketCap / (1 + ch / 100) : null;
  const q = quickFilter({ ...pool, marketCap: baseMcap, change: { ...pool.change, h24: 0 } }, now);
  return { ...q, baseMcap };
}

// Funnel counter: tallies every rejection reason.
export function tally(counter, reasons) {
  for (const r of reasons) counter[r] = (counter[r] || 0) + 1;
}
