// CASE STUDIES — reverse-engineer named runners.
//
// For each coin: full daily history since launch (GeckoTerminal keeps 6 months, which
// covers all of Robinhood Chain), its first 72 hours hour-by-hour, current holders /
// tokenomics, and EVERY 3x+ run it made. For each run we measure what the coin looked
// like right before it (age, market cap, volume trend, base, distance from high) and
// whether our current scanner rules would have caught it.
//
// Coins: env CASE_COINS="SYMBOL or 0xADDRESS, …" or the defaults below.
// Output: data/research/case-studies.md + .json, and a Telegram summary.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG } from '../config.js';
import * as gecko from '../src/gecko.js';
import * as bs from '../src/blockscout.js';
import { DATA_DIR } from '../src/store.js';
import { notify } from '../src/notify.js';

const DAY = 86_400_000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

export const DEFAULT_COINS = [
  'CASHCAT:0x020bfc650a365f8bb26819deaabf3e21291018b4',
  'PONS:0x39dbed3a2bd333467115de45665cc57f813c4571', // the real one — ticker search finds copycats
  'FRONG:0x6245e67affa44a23077f0ea7f981a8dc743a0c47',
  'DIH:0x0c1ed62d7811e5b437e537ac9d0592469c119c74', // research winner (5.5x, Aug)
  '🪶:0xa870f8c7cae9705194a141b0c2964b6c79ee3742', // research winner (3.5x, Aug)
];

const fmtUsd = (v) => (v == null || !Number.isFinite(v) ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`);
const d = (t) => new Date(t).toISOString().slice(0, 10);

// ── find the coin's main pool ───────────────────────────────
async function resolve(spec) {
  const [sym, addr] = spec.split(':');
  const isAddr = /^0x[0-9a-f]{40}$/i.test(sym);
  const token = (addr || (isAddr ? sym : null))?.toLowerCase() || null;
  if (token) {
    const pools = await gecko.topPoolsFor([token]);
    if (pools[token]) {
      const [p] = await gecko.poolsMulti([pools[token]]);
      if (p) return { label: isAddr ? p.baseToken.symbol : sym, pool: p };
    }
  }
  const found = (await gecko.searchPools(sym)).filter((p) => (p.baseToken.symbol || '').toUpperCase() === sym.toUpperCase());
  if (!found.length) return { label: sym, pool: null };
  found.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  return { label: sym, pool: found[0], alternatives: found.length };
}

// ── every 3x+ run in the daily history ──────────────────────
// A run starts at a local low (lowest close of the 5 days before and 2 after) and
// peaks ≥3x within 30 days. Launch day counts too (start = first open).
export function findRuns(candles, { mcapFactor = null, minX = 3, windowDays = 30 } = {}) {
  const runs = [];
  if (!candles?.length) return runs;
  const first = candles[0].t;
  let i = 0;
  const startPrice = (k) => (k === 0 ? Math.min(candles[0].o || candles[0].c, candles[0].l || candles[0].c) : candles[k].c);
  while (i < candles.length - 1) {
    const lo = Math.max(0, i - 5);
    const hi = Math.min(candles.length - 1, i + 2);
    const isLow = i === 0 || candles[i].c <= Math.min(...candles.slice(lo, hi + 1).map((x) => x.c));
    if (isLow && startPrice(i) > 0 && i > 0) {
      // slide the start forward to the LAST day still at base level (within 15% of the low)
      // before price first reaches 3x — that's the moment right before the move
      const low = candles[i].c;
      const hit = candles.findIndex((x, k) => k > i && x.h >= low * minX && x.t <= candles[i].t + windowDays * DAY);
      if (hit > 0) {
        let j = i;
        for (let k = i; k < hit; k++) if (candles[k].c <= low * 1.15) j = k;
        i = j;
      }
    }
    const sp = startPrice(i);
    if (isLow && sp > 0) {
      const future = candles.slice(i + (i === 0 ? 0 : 1)).filter((x) => x.t <= candles[i].t + windowDays * DAY);
      let peakIdx = -1;
      let peak = 0;
      future.forEach((x, k) => { if (x.h > peak) { peak = x.h; peakIdx = k; } });
      const x3 = future.findIndex((x) => x.h >= sp * minX);
      if (peak / sp >= minX && x3 >= 0) {
        const pre = candles.slice(Math.max(0, i - 7), i);
        const pre3 = candles.slice(Math.max(0, i - 3), i);
        const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x.v, 0) / arr.length : null);
        const athBefore = i > 0 ? Math.max(...candles.slice(0, i).map((x) => x.h)) : null;
        const preCloses = pre.map((x) => x.c).filter((x) => x > 0);
        const runSlice = future.slice(0, peakIdx + 1);
        runs.push({
          start: candles[i].t,
          ageDays: (candles[i].t - first) / DAY,
          startPrice: sp,
          startMcap: mcapFactor ? sp * mcapFactor : null,
          peakX: peak / sp,
          peakMcap: mcapFactor ? peak * mcapFactor : null,
          daysTo3x: Math.round((future[x3].t - candles[i].t) / DAY),
          daysToPeak: Math.round((future[peakIdx].t - candles[i].t) / DAY),
          drawdownFromAth: athBefore ? (1 - sp / athBefore) * 100 : null,
          baseRange: preCloses.length >= 4 ? Math.max(...preCloses) / Math.min(...preCloses) : null,
          volTrend: avg(pre3) && avg(pre) ? avg(pre3) / avg(pre) : null, // last 3 days vs last 7 days before the start
          volIgnition: avg(pre) ? Math.max(...runSlice.map((x) => x.v)) / avg(pre) : null,
          runVolumeUsd: runSlice.reduce((s, x) => s + x.v, 0),
          isLaunchRun: i === 0 || (candles[i].t - first) / DAY < 2,
        });
        // jump past this run's peak
        const peakT = future[peakIdx].t;
        i = candles.findIndex((x) => x.t > peakT);
        if (i < 0) break;
        continue;
      }
    }
    i += 1;
  }
  return runs;
}

// Would today's scanner rules have flagged the coin at the run's start?
export function wouldScannerCatch(run) {
  const misses = [];
  if (run.ageDays < CONFIG.minAgeDays) misses.push(`only ${Math.floor(run.ageDays)}d old (rule: ${CONFIG.minAgeDays}d+)`);
  if (run.startMcap != null && run.startMcap > CONFIG.maxMarketCap) misses.push(`market cap ${fmtUsd(run.startMcap)} (rule: ≤ ${fmtUsd(CONFIG.maxMarketCap)})`);
  if (run.startMcap != null && run.startMcap < CONFIG.minMarketCap) misses.push(`market cap ${fmtUsd(run.startMcap)} (rule: ≥ ${fmtUsd(CONFIG.minMarketCap)})`);
  const lane = run.startMcap != null && run.startMcap > CONFIG.lanes.microMaxMarketCap ? 'quality' : 'micro';
  return { caught: misses.length === 0, misses, lane };
}

export async function main() {
  const now = Date.now();
  const specs = (process.env.CASE_COINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const coins = specs.length ? specs : DEFAULT_COINS;
  const results = [];
  for (const spec of coins) {
    let r;
    try {
      r = await resolve(spec);
    } catch (e) {
      results.push({ label: spec.split(':')[0], error: `lookup failed: ${e.message.slice(0, 80)}` });
      continue;
    }
    if (!r.pool) {
      results.push({ label: r.label, error: 'no pool found on Robinhood Chain (GeckoTerminal search)' });
      continue;
    }
    const p = r.pool;
    const token = p.baseToken.address;
    const mcapFactor = p.marketCap && p.priceUsd ? p.marketCap / p.priceUsd : null;
    let daily = [];
    try {
      daily = await gecko.ohlcv(p.poolAddress, 'day', { limit: 200 });
    } catch (e) {
      log('daily failed', r.label, e.message);
    }
    let firstHours = [];
    if (daily.length) {
      try {
        firstHours = await gecko.ohlcv(p.poolAddress, 'hour', { limit: 72, before: daily[0].t + 3 * DAY });
      } catch { /* optional */ }
    }
    let info = null;
    try { info = await gecko.tokenInfo(token); } catch { /* optional */ }
    let holders = null;
    let burnedPct = null;
    try {
      const meta = await bs.tokenMeta(token);
      holders = meta?.holders ?? info?.holders ?? null;
      const top = await bs.topHolders(token);
      if (meta?.totalSupply && top.length) burnedPct = bs.concentration(top, meta.totalSupply, { poolAddresses: [p.poolAddress] })?.burnedPct ?? null;
    } catch { holders = info?.holders ?? null; }

    const runs = findRuns(daily, { mcapFactor }).map((x) => ({ ...x, scanner: wouldScannerCatch(x) }));
    const launch = firstHours.length
      ? {
          firstPrice: firstHours[0].o || firstHours[0].c,
          high24h: Math.max(...firstHours.filter((x) => x.t < firstHours[0].t + DAY).map((x) => x.h)),
          high72h: Math.max(...firstHours.map((x) => x.h)),
        }
      : null;
    const ath = daily.length ? Math.max(...daily.map((x) => x.h)) : null;
    results.push({
      label: r.label, symbol: p.baseToken.symbol, token, pool: p.poolAddress, quote: p.quoteToken.symbol,
      launchedAt: daily[0]?.t ?? null, ageDays: daily[0] ? (now - daily[0].t) / DAY : null,
      mcapNow: p.marketCap, liquidityNow: p.liquidityUsd, priceNow: p.priceUsd,
      athMcap: ath && mcapFactor ? ath * mcapFactor : null, offAthPct: ath ? (1 - p.priceUsd / ath) * 100 : null,
      holders, burnedPct, buyers24h: p.buyers24h, sellers24h: p.sellers24h, volume24h: p.volume24h,
      socials: info ? { x: info.twitter, tg: info.telegram, web: info.websites?.[0] || null } : null,
      gtScore: info?.gtScore ?? null, devPct: info?.devPct ?? null, top10RawPct: info?.top10PctRaw ?? null,
      launch: launch && { ...launch, x24h: launch.high24h / launch.firstPrice, x72h: launch.high72h / launch.firstPrice },
      runs, alternatives: r.alternatives || 1,
    });
    log(`${r.label}: ${runs.length} run(s)`);
  }

  // ── write report ──────────────────────────────────────────
  const outDir = path.join(DATA_DIR, 'research');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'case-studies.json'), JSON.stringify({ at: new Date(now).toISOString(), results }, null, 1));
  const L = [`# Case studies — why these coins ran`, `_Generated ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC_`, ''];
  for (const c of results) {
    L.push(`## $${c.label}`);
    if (c.error) { L.push(`- ⚠️ ${c.error}`, ''); continue; }
    L.push(`- Launched ${c.launchedAt ? d(c.launchedAt) : '?'} (${Math.floor(c.ageDays)}d ago) · paired with ${c.quote}`);
    L.push(`- Now: ${fmtUsd(c.mcapNow)} mc · liquidity ${fmtUsd(c.liquidityNow)} · ${c.holders?.toLocaleString?.() ?? '—'} holders · ${c.offAthPct != null ? `${c.offAthPct.toFixed(0)}% off its high (${fmtUsd(c.athMcap)})` : ''}`);
    L.push(`- Tokenomics/safety: burned ${c.burnedPct != null ? `${c.burnedPct.toFixed(1)}%` : '—'} · dev ${c.devPct != null ? `${c.devPct}%` : '—'} · top-10 (raw, incl. pool) ${c.top10RawPct ?? '—'}% · GT score ${c.gtScore != null ? Math.round(c.gtScore) : '—'}`);
    if (c.socials) L.push(`- Socials: ${[c.socials.x && `X @${c.socials.x}`, c.socials.tg && `TG @${c.socials.tg}`, c.socials.web].filter(Boolean).join(' · ') || 'none listed'}`);
    if (c.launch) L.push(`- Launch: ${c.launch.x24h.toFixed(1)}× in the first 24h, ${c.launch.x72h.toFixed(1)}× within 72h (from first trade)`);
    if (!c.runs.length) L.push('- No 3x+ run found in the daily data.');
    c.runs.forEach((x, k) => {
      L.push(`- **Run ${k + 1}:** ${d(x.start)} · age ${Math.floor(x.ageDays)}d · from ${fmtUsd(x.startMcap)} → peak ${x.peakX.toFixed(1)}× (${fmtUsd(x.peakMcap)}) · 3x in ${x.daysTo3x}d, peak in ${x.daysToPeak}d`);
      L.push(`  - Before it: ${x.drawdownFromAth != null ? `${x.drawdownFromAth.toFixed(0)}% off prior high` : 'launch run'} · 7d range ${x.baseRange ? `${x.baseRange.toFixed(2)}×` : '—'} · volume trend ${x.volTrend ? `${x.volTrend.toFixed(2)}×` : '—'} · ignition ${x.volIgnition ? `${x.volIgnition.toFixed(1)}×` : '—'}`);
      L.push(`  - Our scanner: ${x.scanner.caught ? `✅ would have been eligible (${x.scanner.lane} lane${x.scanner.lane === 'quality' ? ' — also needs 5k+ holders, $100k+ liquidity, 50–90% off high' : ''})` : `❌ would have missed it — ${x.scanner.misses.join('; ')}`}`);
    });
    L.push('');
  }
  fs.writeFileSync(path.join(outDir, 'case-studies.md'), L.join('\n') + '\n');

  const tg = ['🔬 CASE STUDIES — why these coins ran', ''];
  for (const c of results) {
    if (c.error) { tg.push(`$${c.label}: ${c.error}`); continue; }
    const caught = c.runs.filter((x) => x.scanner.caught).length;
    tg.push(`$${c.label}: ${c.runs.length} run(s) of 3x+ · scanner would have caught ${caught}`);
  }
  tg.push('', 'Full breakdown: data/research/case-studies.md');
  await notify(tg.join('\n'));
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
