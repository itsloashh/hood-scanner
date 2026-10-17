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
  if ((pool.liquidityUsd ?? 0) < c.minLiquidityUsd) reasons.push('liquidity too thin');
  if (age == null || age < c.minAgeDays) reasons.push(`younger than ${c.minAgeDays}d`);
  if (pool.buyers24h < c.community.minBuyers24h) reasons.push('too few buyers 24h');
  if (pool.sellers24h < c.community.minSellers24h) reasons.push('almost no sellers (honeypot risk)');
  if ((pool.change.h24 ?? 0) > c.maxChange24hPct) reasons.push('already pumping');
  if ((pool.susReports || 0) > c.community.maxSusReports) reasons.push('flagged suspicious on GeckoTerminal');
  return { ok: reasons.length === 0, reasons, ageDays: age };
}

export function deepFilter({ info, holdersCount, conc, community }) {
  const c = CONFIG;
  const reasons = [];
  const warnings = [...(community?.flags || [])];

  if (info?.isHoneypot === true || info?.isHoneypot === 'yes') reasons.push('flagged honeypot');

  if (holdersCount == null) reasons.push('holder count unavailable');
  else if (holdersCount < c.community.minHolders) reasons.push('too few holders');

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
