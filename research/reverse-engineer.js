// REVERSE-ENGINEER PAST RUNNERS
//
// Runs daily (and on demand). Answers: "Which Robinhood Chain coins fit our profile
// and then ran 3x+, who bought them before the run, and what did the winners have
// in common that the duds didn't?"
//
//  1. Collect candidate coins (holder-count list, scanner watchlist, research history).
//  2. Walk each coin's daily chart and find SETUPS — days where it matched our rules:
//       ≥21 days old · $10k–$333k market cap · ≥50% off its high · 7-day base ≤1.8× range
//  3. Label each setup: WIN = peaked between 3x and 10x within 30 days (our target),
//     MOON = went past 10x (reported, but not used to learn — outliers mislead),
//     DUD = never reached 3x.
//  4. With a Blockscout key, pull each setup's token transfers and measure:
//       • community: real buyers in the week before, growth vs the week before that,
//         wash trading (same wallets on both sides) — fake runs are excluded
//       • burns: supply sent to burn addresses before and during the run, % burned now
//       • smart wallets: wallets that bought early into several winners, rarely duds
//  5. "Why it pumped": for every real winner, list the catalysts the data shows
//     (volume ignition, buyer surge, burns, smart money, theme, stock pairing). Compare
//     how often each catalyst shows up in winners vs duds → the parameters worth adding.
//  6. Write data/research/report.md, setups.csv, catalysts.json, smart-wallets.json
//     and send a Telegram summary.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG } from '../config.js';
import * as gecko from '../src/gecko.js';
import * as bs from '../src/blockscout.js';
import { loadState, DATA_DIR, appendCsv } from '../src/store.js';
import { notify } from '../src/notify.js';
import { tagNarratives } from '../src/narrative.js';

const DAY = 86_400_000;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const median = (arr) => {
  const v = arr.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

export const R = {
  maxCoins: 220,
  chartDays: 180,
  baseMaxRange: 1.8,
  minDrawdownPct: 50,
  winMultiple: 3,
  maxMultiple: 10, // above this = MOON (outlier), not a target win
  windowDays: 30,
  minGapDays: 30, // one setup per coin per 30 days
  maxWalletSetups: 30, // setups (winners first) whose buyers we pull
  maxTransferPages: 30, // per setup (50 transfers/page)
  preRunDays: 7,
  minRealBuyers: 15, // community gate: at least this many real (non-bundled) buyers the week before
  ignitionVolX: 3, // volume ≥3× normal on some day of the run = "volume ignition"
  surgePct: 50, // buyers up ≥50% week-over-week before the setup = "buyer surge"
  smartMinWinnerHits: 2,
  smartMinPrecision: 0.5, // ≥50% of a wallet's early buys (in our sample) were winners
  sprayMaxShare: 0.5, // wallet in >50% of analysed setups = bot, not skill
};

// ── step 1: candidate coins ─────────────────────────────────
async function collectCoins(state) {
  const coins = new Map(); // token → { pool, symbol }
  const add = (t, pool, symbol) => t && pool && !coins.has(t) && coins.set(t, { pool, symbol });
  for (const [t, v] of Object.entries(state.universe || {})) add(t, v.pool, v.symbol);
  for (const [t, v] of Object.entries(state.watchlist || {})) add(t, v.pool, v.symbol);

  // research history: every coin the scanner has ever logged under $1M
  const snapDir = path.join(DATA_DIR, 'snapshots');
  if (fs.existsSync(snapDir)) {
    for (const f of fs.readdirSync(snapDir).filter((x) => x.endsWith('.csv'))) {
      const [head, ...rows] = fs.readFileSync(path.join(snapDir, f), 'utf8').trim().split('\n');
      const cols = head.split(',');
      const ti = cols.indexOf('token'), pi = cols.indexOf('pool'), si = cols.indexOf('symbol');
      for (const r of rows) {
        const c = r.split(',');
        add(c[ti], c[pi], c[si]);
      }
    }
  }

  // holder-count list (needs Blockscout to answer)
  try {
    const list = await bs.listTokensByHolders(10);
    const fresh = list
      .filter((t) => t.holders >= 100 && !coins.has(t.address))
      .filter((t) => !CONFIG.excludeNamePattern.test(`${t.name || ''} ${t.symbol || ''}`))
      .filter((t) => !CONFIG.ignoreSymbols.includes((t.symbol || '').toUpperCase()));
    const pools = await gecko.topPoolsFor(fresh.map((t) => t.address));
    for (const t of fresh) add(t.address, pools[t.address], t.symbol);
  } catch (e) {
    log('holder-count list unavailable:', e.message);
  }
  return [...coins.entries()].slice(0, R.maxCoins).map(([token, v]) => ({ token, ...v }));
}

// ── step 2–3: setups + labels from the daily chart ──────────
export function findSetups(candles, { mcapNow, priceNow }, now = Date.now()) {
  if (!candles?.length || !mcapNow || !priceNow) return [];
  const supplyFactor = mcapNow / priceNow; // market cap per $1 of price (constant supply assumed)
  const first = candles[0].t;
  const out = [];
  let lastSetup = -Infinity;
  let ath = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    ath = Math.max(ath, c.h);
    if (i < 7) continue;
    const age = (c.t - first) / DAY;
    const mcap = c.c * supplyFactor;
    const closes = candles.slice(i - 6, i + 1).map((x) => x.c).filter((x) => x > 0);
    const range = closes.length >= 5 ? Math.max(...closes) / Math.min(...closes) : null;
    const dd = ath > 0 ? (1 - c.c / ath) * 100 : 0;
    if (age < CONFIG.minAgeDays || mcap > CONFIG.maxMarketCap || mcap < CONFIG.minMarketCap) continue;
    if (range == null || range > R.baseMaxRange || dd < R.minDrawdownPct) continue;
    // lows holding: the last 3 days made no new low vs the 4 days before (a base, not a bleed)
    const recentLow = Math.min(...candles.slice(i - 2, i + 1).map((x) => x.l));
    const priorLow = Math.min(...candles.slice(i - 6, i - 2).map((x) => x.l));
    if (recentLow < priorLow * 0.97) continue;
    if (c.t - lastSetup < R.minGapDays * DAY) continue;

    const future = candles.slice(i + 1).filter((x) => x.t <= c.t + R.windowDays * DAY);
    const matured = now - c.t >= R.windowDays * DAY;
    const peak = future.length ? Math.max(...future.map((x) => x.h)) : c.c;
    const peakX = peak / c.c;
    const hitIdx = future.findIndex((x) => x.h >= c.c * R.winMultiple);
    const label = hitIdx >= 0 ? (peakX > R.maxMultiple ? 'MOON' : 'WIN') : matured ? 'DUD' : null; // null = still playing out
    if (!label) continue;

    const prev7 = candles.slice(i - 7, i);
    const avgVol = prev7.reduce((s, x) => s + x.v, 0) / prev7.length;
    // volume ignition: biggest day of the following window vs the normal before it
    const maxRunVol = future.length ? Math.max(...future.map((x) => x.v)) : 0;
    const igIdx = future.findIndex((x) => avgVol > 0 && x.v >= avgVol * R.ignitionVolX);
    lastSetup = c.t;
    out.push({
      t: c.t,
      label,
      peakX,
      daysTo3x: hitIdx >= 0 ? Math.round((future[hitIdx].t - c.t) / DAY) : null,
      price: c.c,
      mcap,
      ageDays: age,
      drawdownPct: dd,
      baseRange: range,
      volRatio: avgVol > 0 ? c.v / avgVol : null,
      volumeUsd: c.v,
      runVolX: avgVol > 0 ? maxRunVol / avgVol : null,
      ignitionDay: igIdx >= 0 ? Math.round((future[igIdx].t - c.t) / DAY) : null,
    });
  }
  return out;
}

// ── step 4: what the token transfers say ────────────────────
// A "buy" = tokens moving from a contract (pool / router / pool manager) to a normal wallet.
// A "sell" = a normal wallet sending tokens to a contract (not a burn address).
// A "burn" = tokens sent to 0x…dead or 0x0.
export function analyzeTransfers(transfers, setupT, { preDays = R.preRunDays, windowDays = R.windowDays } = {}) {
  const start = setupT - preDays * DAY;
  const prevStart = setupT - 2 * preDays * DAY;
  const end = setupT + DAY;
  const oldest = transfers.length ? Math.min(...transfers.map((x) => x.ts || Infinity)) : Infinity;
  const covered = transfers.length > 0 && oldest <= start;
  const coveredPrev = transfers.length > 0 && oldest <= prevStart;

  const isBuy = (x) => x.fromIsContract && !x.toIsContract && x.to && !bs.BURN_ADDRESSES.has(x.from) && !bs.BURN_ADDRESSES.has(x.to);
  const isSell = (x) => !x.fromIsContract && x.toIsContract && x.from && !bs.BURN_ADDRESSES.has(x.to);
  const isBurn = (x) => bs.BURN_ADDRESSES.has(x.to) && !bs.BURN_ADDRESSES.has(x.from);

  const pre = transfers.filter((x) => x.ts && x.ts >= start && x.ts <= end);
  const buys = pre.filter(isBuy);
  const sells = pre.filter(isSell);

  // bundles: ≥3 different wallets receiving in the same block
  const byBlock = new Map();
  for (const b of buys) {
    if (!byBlock.has(b.block)) byBlock.set(b.block, new Set());
    byBlock.get(b.block).add(b.to);
  }
  const bundled = new Set();
  for (const set of byBlock.values()) if (set.size >= CONFIG.wallets.bundleMinWallets) for (const a of set) bundled.add(a);

  const wallets = new Map();
  for (const b of buys) {
    if (bundled.has(b.to)) continue;
    const w = wallets.get(b.to) || { buys: 0, firstTs: b.ts, tokens: 0 };
    w.buys += 1;
    w.firstTs = Math.min(w.firstTs, b.ts);
    w.tokens += Number(BigInt(b.value) / 10n ** BigInt(Math.max(0, b.decimals - 4))) / 1e4;
    wallets.set(b.to, w);
  }

  // community: buyer growth week-over-week, and wash trading
  const prevBuyers = coveredPrev
    ? new Set(transfers.filter((x) => x.ts >= prevStart && x.ts < start && isBuy(x)).map((x) => x.to)).size
    : null;
  const sellers = new Set(sells.map((x) => x.from));
  const traders = new Set([...wallets.keys(), ...sellers]);
  const both = [...wallets.keys()].filter((a) => sellers.has(a)).length;
  const overlap = traders.size ? both / traders.size : 0;
  const tradesPerWallet = traders.size ? (buys.length + sells.length) / traders.size : 0;
  const washLikely = traders.size >= 5 && overlap >= 0.6 && tradesPerWallet >= 4;

  // burns
  const toUnits = (x) => Number(BigInt(x.value) / 10n ** BigInt(Math.max(0, x.decimals - 4))) / 1e4;
  const burnsPre = transfers.filter((x) => x.ts && x.ts >= prevStart && x.ts <= end && isBurn(x));
  const burnsDuring = transfers.filter((x) => x.ts && x.ts > end && x.ts <= setupT + windowDays * DAY && isBurn(x));

  return {
    wallets,
    bundledCount: bundled.size,
    rawBuys: buys.length,
    covered,
    realBuyers: wallets.size,
    prevBuyers,
    buyerGrowthPct: prevBuyers ? ((wallets.size - prevBuyers) / prevBuyers) * 100 : null,
    overlap,
    tradesPerWallet,
    washLikely,
    burnsPre: burnsPre.length,
    burnsDuring: burnsDuring.length,
    burnedUnitsDuring: burnsDuring.reduce((s, x) => s + toUnits(x), 0),
  };
}

// kept for compatibility with earlier callers/tests
export const preRunBuyers = (transfers, setupT, preDays = R.preRunDays) => analyzeTransfers(transfers, setupT, { preDays });

// Community gate: real runs only (enough real buyers, no wash trading)
export const isViable = (a) => a.covered && a.realBuyers >= R.minRealBuyers && !a.washLikely;

// What the data says drove a run. `pre` = knowable before the pump (usable as a live
// parameter); `during` = what happened in the run itself (explains it, can't predict it).
export function catalysts(setup, tx, extra = {}) {
  const c = [];
  const add = (key, label, when) => c.push({ key, label, when });
  if (setup.volRatio != null && setup.volRatio >= 1.5) add('setupVolume', `volume already ${setup.volRatio.toFixed(1)}× normal on the setup day`, 'pre');
  if (tx?.buyerGrowthPct != null && tx.buyerGrowthPct >= R.surgePct) add('buyerSurge', `buyers up ${Math.round(tx.buyerGrowthPct)}% vs the week before`, 'pre');
  if (tx?.burnsPre > 0) add('burnsBefore', `${tx.burnsPre} burn(s) in the 2 weeks before`, 'pre');
  if (extra.smartBuyers > 0) add('smartMoney', `${extra.smartBuyers} smart wallet(s) bought before the run`, 'pre');
  if (extra.burnedPctNow != null && extra.burnedPctNow >= 20) add('bigBurn', `${extra.burnedPctNow.toFixed(0)}% of supply burned`, 'pre');
  if (extra.stockPaired) add('stockPaired', 'trades against a stock token', 'pre');
  for (const t of (extra.themes || []).filter((x) => x !== 'stock-paired')) add(`theme:${t}`, `${t} theme`, 'pre');
  if (setup.runVolX != null && setup.runVolX >= R.ignitionVolX) {
    add('volumeIgnition', `volume exploded to ${setup.runVolX.toFixed(0)}× normal${setup.ignitionDay != null ? ` on day ${setup.ignitionDay}` : ''}`, 'during');
  }
  if (tx?.burnsDuring > 0) add('burnsDuring', `${tx.burnsDuring} burn(s) during the run`, 'during');
  return c;
}

// How much more often a catalyst shows up in winners than duds
export function catalystLift(winners, duds) {
  const keys = new Set([...winners, ...duds].flatMap((x) => x.catalysts.map((c) => c.key)));
  const rows = [];
  for (const k of keys) {
    const w = winners.filter((x) => x.catalysts.some((c) => c.key === k)).length;
    const d = duds.filter((x) => x.catalysts.some((c) => c.key === k)).length;
    const wr = winners.length ? w / winners.length : 0;
    const dr = duds.length ? d / duds.length : 0;
    const when = [...winners, ...duds].flatMap((x) => x.catalysts).find((c) => c.key === k)?.when;
    rows.push({ key: k, when, winners: w, winnersOf: winners.length, duds: d, dudsOf: duds.length, winRate: wr, dudRate: dr, lift: dr > 0 ? wr / dr : wr > 0 ? Infinity : 0 });
  }
  return rows.sort((a, b) => b.lift - a.lift || b.winners - a.winners);
}

// Wallet overlap across setups → smart wallets
export function findSmartWallets(analysed) {
  const n = analysed.length;
  const stats = new Map(); // wallet → { win, dud, syms:Set }
  for (const a of analysed) {
    for (const addr of a.buyers.wallets.keys()) {
      const s = stats.get(addr) || { win: 0, dud: 0, syms: new Set() };
      if (a.setup.label === 'WIN' || a.setup.label === 'MOON') s.win += 1;
      else s.dud += 1;
      s.syms.add(a.symbol);
      stats.set(addr, s);
    }
  }
  const smart = [];
  for (const [addr, s] of stats) {
    const appearances = s.win + s.dud;
    if (n >= 4 && appearances / n > R.sprayMaxShare) continue; // in everything = bot
    if (s.win >= R.smartMinWinnerHits && s.win / appearances >= R.smartMinPrecision) {
      smart.push({ addr, wins: s.win, duds: s.dud, coins: [...s.syms] });
    }
  }
  smart.sort((a, b) => b.wins - a.wins || a.duds - b.duds);
  return smart;
}

// ── report helpers ──────────────────────────────────────────
function compareLine(label, wins, duds, key, fmt) {
  const w = median(wins.map((s) => s[key]));
  const d = median(duds.map((s) => s[key]));
  if (w == null || d == null) return null;
  return `- **${label}:** winners ${fmt(w)} vs duds ${fmt(d)}`;
}

export async function main() {
  const now = Date.now();
  const state = loadState();
  const outDir = path.join(DATA_DIR, 'research');
  fs.mkdirSync(outDir, { recursive: true });

  const coins = await collectCoins(state);
  log(`research: ${coins.length} candidate coins`);

  // current price + market cap + pair info for every coin's pool
  const live = new Map();
  try {
    for (const p of await gecko.poolsMulti(coins.map((c) => c.pool))) live.set(p.poolAddress, p);
  } catch (e) {
    log('pool refresh failed:', e.message);
  }

  // steps 2–3: setups from the daily charts
  const setups = [];
  for (const c of coins) {
    const p = live.get(c.pool);
    if (!p?.priceUsd || !p?.marketCap) continue;
    let candles = [];
    try {
      candles = await gecko.ohlcvDaily(c.pool, R.chartDays);
    } catch {
      continue;
    }
    const { tags, stockPaired } = tagNarratives(p);
    for (const s of findSetups(candles, { mcapNow: p.marketCap, priceNow: p.priceUsd }, now)) {
      setups.push({ ...c, symbol: c.symbol || p.baseToken.symbol, themes: tags, stockPaired, setup: s });
    }
  }
  const byLabel = (l) => setups.filter((s) => s.setup.label === l);
  log(`research: ${setups.length} setups → ${byLabel('WIN').length} wins (3–10x), ${byLabel('MOON').length} moons (>10x), ${byLabel('DUD').length} duds`);

  // step 4: transfers → community, burns, early wallets (needs Blockscout)
  const notes = [];
  const burnCache = new Map();
  const ranked = [...byLabel('WIN'), ...byLabel('MOON'), ...byLabel('DUD')];
  let blocked = false;
  for (const s of ranked.slice(0, R.maxWalletSetups)) {
    if (blocked) break;
    try {
      const transfers = await bs.tokenTransfers(s.token, {
        sinceMs: s.setup.t - 2 * R.preRunDays * DAY,
        maxPages: R.maxTransferPages,
      });
      const tx = analyzeTransfers(transfers, s.setup.t);
      if (!tx.covered) {
        notes.push(`$${s.symbol}: too much trading since the setup to reach back that far — wallet data skipped`);
        continue;
      }
      s.tx = tx;
      if (!burnCache.has(s.token)) {
        let burnedPctNow = null;
        try {
          const [meta, holders] = await Promise.all([bs.tokenMeta(s.token), bs.topHolders(s.token)]);
          const conc = meta?.totalSupply && holders.length ? bs.concentration(holders, meta.totalSupply) : null;
          burnedPctNow = conc?.burnedPct ?? null;
        } catch { /* optional */ }
        burnCache.set(s.token, burnedPctNow);
      }
      s.burnedPctNow = burnCache.get(s.token);
    } catch (e) {
      notes.push(`$${s.symbol}: wallet history unavailable (${e.message.slice(0, 60)})`);
      if (/HTTP 40[13]/.test(e.message)) {
        notes.push('Blockscout refused the requests — add the free BLOCKSCOUT_API_KEY secret to enable wallet, community and burn research.');
        blocked = true;
      }
    }
  }

  // community gate: drop fake/thin runs from the learning set
  const analysed = setups.filter((s) => s.tx);
  const viable = analysed.filter((s) => isViable(s.tx));
  const rejected = analysed.filter((s) => !isViable(s.tx));
  const smart = findSmartWallets(viable.map((s) => ({ symbol: s.symbol, setup: s.setup, buyers: s.tx })));
  const smartSet = new Set(smart.map((x) => x.addr));

  // learning set: wallet-checked setups if we have them, otherwise every setup
  const pool = analysed.length ? viable : setups;
  for (const s of setups) {
    s.smartBuyers = s.tx ? [...s.tx.wallets.keys()].filter((a) => smartSet.has(a)).length : 0;
    s.catalysts = catalysts(s.setup, s.tx, { smartBuyers: s.smartBuyers, burnedPctNow: s.burnedPctNow, stockPaired: s.stockPaired, themes: s.themes });
  }
  const wins = pool.filter((s) => s.setup.label === 'WIN');
  const moons = setups.filter((s) => s.setup.label === 'MOON');
  const duds = pool.filter((s) => s.setup.label === 'DUD');
  const lift = catalystLift(wins, duds);

  // ── files ───────────────────────────────────────────────
  const csvPath = path.join(outDir, 'setups.csv');
  if (fs.existsSync(csvPath)) fs.rmSync(csvPath);
  const f = (v, d = 2) => (v == null || !Number.isFinite(v) ? '' : Number(v).toFixed(d));
  appendCsv('research/setups.csv',
    ['date', 'symbol', 'token', 'label', 'peakX', 'daysTo3x', 'mcap', 'ageDays', 'drawdownPct', 'baseRange', 'volRatio', 'runVolX',
      'realBuyers', 'buyerGrowthPct', 'washLikely', 'viable', 'burnsPre', 'burnsDuring', 'burnedPctNow', 'smartBuyers', 'themes', 'catalysts'],
    setups.map((s) => ({
      date: new Date(s.setup.t).toISOString().slice(0, 10), symbol: s.symbol, token: s.token, label: s.setup.label,
      peakX: f(s.setup.peakX), daysTo3x: s.setup.daysTo3x, mcap: Math.round(s.setup.mcap), ageDays: f(s.setup.ageDays, 0),
      drawdownPct: f(s.setup.drawdownPct, 0), baseRange: f(s.setup.baseRange), volRatio: f(s.setup.volRatio), runVolX: f(s.setup.runVolX, 1),
      realBuyers: s.tx?.realBuyers, buyerGrowthPct: f(s.tx?.buyerGrowthPct, 0), washLikely: s.tx ? s.tx.washLikely : '',
      viable: s.tx ? isViable(s.tx) : '', burnsPre: s.tx?.burnsPre, burnsDuring: s.tx?.burnsDuring, burnedPctNow: f(s.burnedPctNow, 1),
      smartBuyers: s.smartBuyers, themes: (s.themes || []).join('|'), catalysts: s.catalysts.map((c) => c.key).join('|'),
    })));
  fs.writeFileSync(path.join(outDir, 'smart-wallets.json'), JSON.stringify({ at: new Date(now).toISOString(), wallets: smart }, null, 1));
  fs.writeFileSync(path.join(outDir, 'catalysts.json'), JSON.stringify({ at: new Date(now).toISOString(), wins: wins.length, duds: duds.length, lift }, null, 1));

  // ── report ──────────────────────────────────────────────
  const hitRate = wins.length + duds.length ? (wins.length / (wins.length + duds.length)) * 100 : 0;
  const fx = (d = 1) => (v) => `${v.toFixed(d)}×`;
  const pctF = (v) => `${v.toFixed(0)}%`;
  const usdF = (v) => (v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`);
  const W = wins.map((x) => ({ ...x.setup, realBuyers: x.tx?.realBuyers, buyerGrowthPct: x.tx?.buyerGrowthPct }));
  const D = duds.map((x) => ({ ...x.setup, realBuyers: x.tx?.realBuyers, buyerGrowthPct: x.tx?.buyerGrowthPct }));
  const liftLine = (r) => {
    const label = r.key.startsWith('theme:') ? `${r.key.slice(6)} theme` : CAT_LABEL[r.key] || r.key;
    const ratio = r.lift === Infinity ? 'only in winners' : r.lift >= 1 ? `${r.lift.toFixed(1)}× more common in winners` : 'more common in duds';
    return `- **${label}**${r.when === 'during' ? ' _(happens during the run — explains, can’t predict)_' : ''}: ${r.winners}/${r.winnersOf} winners vs ${r.duds}/${r.dudsOf} duds — ${ratio}`;
  };
  const lines = [
    `# Robinhood Chain — why coins pumped (3–10x)`,
    `_Generated ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC from ${coins.length} coins._`,
    '',
    `## The base rate`,
    `${setups.length} times a coin matched our rules (21+ days old, $10k–$333k, 50%+ off its high, tight base with lows holding).`,
    `- **${byLabel('WIN').length} went 3–10x** within 30 days (our target)`,
    `- ${moons.length} went past 10x (outliers — listed, not used to learn)`,
    `- ${byLabel('DUD').length} never reached 3x`,
    analysed.length
      ? `- Community check: ${rejected.length} of ${analysed.length} wallet-checked setups were thrown out (fewer than ${R.minRealBuyers} real buyers, or wash trading).`
      : '- Community check skipped (no wallet data this run).',
    '',
    `**Hit rate on real setups: ${hitRate.toFixed(0)}%** (${wins.length} wins / ${wins.length + duds.length}). Any parameter is only worth adding if coins with it beat this.`,
    '',
    `## Which signals showed up before winners`,
    lift.length ? 'Ranked by how much more often they appear in 3–10x winners than in duds:' : 'Not enough data yet.',
    ...lift.slice(0, 12).map(liftLine),
    '',
    `## Winners vs duds (middle value of each group)`,
    compareLine('Volume on the setup day vs its 7-day average', W, D, 'volRatio', fx(1)),
    compareLine('7-day price range (lower = tighter base)', W, D, 'baseRange', fx(2)),
    compareLine('Drop from all-time high', W, D, 'drawdownPct', pctF),
    compareLine('Age', W, D, 'ageDays', (v) => `${v.toFixed(0)} days`),
    compareLine('Market cap', W, D, 'mcap', usdF),
    compareLine('Real buyers the week before', W, D, 'realBuyers', (v) => v.toFixed(0)),
    compareLine('Buyer growth vs the week before that', W, D, 'buyerGrowthPct', (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`),
    '',
    `## Why each winner pumped`,
    ...(wins.length
      ? wins.flatMap((x) => [
          `### $${x.symbol} — ${x.setup.peakX.toFixed(1)}× from ${usdF(x.setup.mcap)} (${new Date(x.setup.t).toISOString().slice(0, 10)}, 3x in ${x.setup.daysTo3x} days)`,
          ...(x.catalysts.length ? x.catalysts.map((c) => `- ${c.when === 'pre' ? 'Before:' : 'During:'} ${c.label}`) : ['- No on-chain catalyst found — likely off-chain (X/KOL, listing, news).']),
          `- Check X (verified accounts): https://x.com/search?q=%24${encodeURIComponent(x.symbol)}%20filter%3Ablue_verified&f=live`,
          '',
        ])
      : ['- None in this sample yet.', '']),
    ...(moons.length ? [`## Moonshots (>10x, not used to learn)`, ...moons.map((x) => `- $${x.symbol} — ${x.setup.peakX.toFixed(0)}× from ${usdF(x.setup.mcap)} (${new Date(x.setup.t).toISOString().slice(0, 10)})`), ''] : []),
    ...(rejected.length ? [`## Thrown out by the community check`, ...rejected.slice(0, 10).map((x) => `- $${x.symbol} (${x.setup.label}) — ${x.tx.washLikely ? `wash trading (${Math.round(x.tx.overlap * 100)}% of wallets on both sides)` : `only ${x.tx.realBuyers} real buyers`}`), ''] : []),
    `## Smart wallets`,
    smart.length
      ? `**${smart.length} wallet(s)** bought early into ${R.smartMinWinnerHits}+ real winners and mostly avoided duds. The live scanner flags any coin they buy.`
      : analysed.length
        ? 'No wallet showed up early in multiple real winners yet — the sample grows every day.'
        : 'Wallet history wasn’t available this run.',
    ...smart.slice(0, 15).map((x) => `- \`${x.addr}\` — early in ${x.wins} winner(s) (${x.coins.join(', ')}), ${x.duds} dud(s)`),
    ...(notes.length ? ['', '## Notes', ...[...new Set(notes)].slice(0, 12).map((n) => `- ${n}`)] : []),
  ];
  fs.writeFileSync(path.join(outDir, 'report.md'), lines.filter((l) => l !== null).join('\n') + '\n');

  // ── Telegram summary ────────────────────────────────────
  const tg = ['🔬 DAILY RESEARCH — why coins pumped', ''];
  tg.push(`${setups.length} times a coin matched your rules → ${byLabel('WIN').length} went 3–10x, ${moons.length} went 10x+, ${byLabel('DUD').length} didn't.`);
  if (analysed.length) tg.push(`${rejected.length} were thrown out as fake or thin (wash trading / under ${R.minRealBuyers} real buyers).`);
  tg.push(`Hit rate on real setups: ${hitRate.toFixed(0)}% — the number every signal has to beat.`);
  const preLift = lift.filter((r) => r.when === 'pre' && r.winners > 0).slice(0, 4);
  if (preLift.length) {
    tg.push('', '📈 Signals that showed up BEFORE winners:');
    for (const r of preLift) {
      const label = r.key.startsWith('theme:') ? `${r.key.slice(6)} theme` : CAT_LABEL[r.key] || r.key;
      tg.push(`• ${label}: ${r.winners}/${r.winnersOf} winners vs ${r.duds}/${r.dudsOf} duds${r.lift === Infinity ? ' (winners only)' : r.lift >= 1 ? ` (${r.lift.toFixed(1)}×)` : ''}`);
    }
  }
  if (wins.length) {
    tg.push('', '🏆 Winners and why:');
    for (const x of wins.slice(0, 5)) {
      const why = x.catalysts.slice(0, 3).map((c) => c.label).join('; ') || 'no on-chain reason — likely X/news';
      tg.push(`• $${x.symbol} ${x.setup.peakX.toFixed(1)}× — ${why}`);
    }
  }
  tg.push('', smart.length
    ? `🧠 ${smart.length} smart wallet(s) caught multiple real winners early. The scanner now watches them.`
    : analysed.length
      ? '🧠 No repeat early buyers across real winners yet.'
      : '🧠 Wallet history unavailable — check the BLOCKSCOUT_API_KEY secret.');
  tg.push('', 'Full report: data/research/report.md in the repo');
  await notify(tg.join('\n'));
  log('research done');
  return { coins: coins.length, setups: setups.length, wins: wins.length, moons: moons.length, smart: smart.length, analysed: analysed.length, viable: viable.length };
}

const CAT_LABEL = {
  setupVolume: 'Volume already rising on the setup day',
  buyerSurge: `Buyers up ${R.surgePct}%+ week-over-week`,
  burnsBefore: 'Token burns in the 2 weeks before',
  smartMoney: 'Smart wallets buying before the run',
  bigBurn: '20%+ of supply burned',
  stockPaired: 'Paired with a stock token',
  volumeIgnition: `Volume explosion (${R.ignitionVolX}×+) during the run`,
  burnsDuring: 'Token burns during the run',
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
