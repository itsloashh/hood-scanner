// Junk filter. Stage 1 uses only the pool list (cheap). Stage 2 runs after
// holder + token info calls. Any failed check rejects the coin, with reasons logged.
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
  else if (pool.marketCap > c.maxMarketCap) reasons.push(`mcap > $${c.maxMarketCap.toLocaleString()}`);
  else if (pool.marketCap < c.minMarketCap) reasons.push('mcap too small (dead)');
  if ((pool.liquidityUsd ?? 0) < c.minLiquidityUsd) reasons.push('liquidity too thin');
  if (age == null || age < c.minAgeDays) reasons.push(`younger than ${c.minAgeDays}d`);
  if (pool.buyers24h < c.community.minBuyers24h) reasons.push('too few buyers 24h');
  if (pool.sellers24h < c.community.minSellers24h) reasons.push('almost no sellers (honeypot risk)');
  if ((pool.change.h24 ?? 0) > c.maxChange24hPct) reasons.push('already pumping (>100% 24h)');
  return { ok: reasons.length === 0, reasons, ageDays: age };
}

export function deepFilter({ info, holdersCount, conc }) {
  const c = CONFIG;
  const reasons = [];
  const warnings = [];

  if (info?.isHoneypot === true || info?.isHoneypot === 'yes') reasons.push('flagged honeypot');

  if (holdersCount == null) reasons.push('holder count unavailable');
  else if (holdersCount < c.community.minHolders) reasons.push(`under ${c.community.minHolders} holders`);

  const socials = countSocials(info);
  if (c.community.requireSocial && socials === 0) reasons.push('no socials linked');

  if (!conc) {
    reasons.push('holder distribution unavailable');
  } else {
    if (conc.top1Pct > c.distribution.maxTop1Pct) reasons.push(`top wallet ${conc.top1Pct.toFixed(1)}%`);
    if (conc.top10Pct > c.distribution.maxTop10Pct) reasons.push(`top 10 wallets ${conc.top10Pct.toFixed(1)}%`);
    if (conc.largestContractPct > 25) warnings.push(`a non-pool contract holds ${conc.largestContractPct.toFixed(0)}% (locker or team vault?)`);
  }

  const devPct = conc?.devPctOnchain ?? info?.devPct;
  if (devPct != null && devPct > c.distribution.maxDevPct) reasons.push(`dev holds ${devPct.toFixed(1)}%`);
  if (info && info.devPct == null && conc?.devPctOnchain == null) warnings.push('dev wallet unknown');

  return { ok: reasons.length === 0, reasons, warnings, socials };
}

export function countSocials(info) {
  if (!info) return 0;
  return (info.twitter ? 1 : 0) + (info.telegram ? 1 : 0) + (info.websites?.length ? 1 : 0) + (info.discord ? 1 : 0);
}
