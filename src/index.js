// HOOD SCANNER — one run: scan → filter → score → alert → paper trade → log.
// Runs every 15 minutes on GitHub Actions (free on a public repo). Locally: `npm run scan`.
import { pathToFileURL } from 'node:url';
import { CONFIG } from '../config.js';
import * as gecko from './gecko.js';
import * as bs from './blockscout.js';
import * as dp from './dexpaprika.js';
import { quickFilter, deepFilter, pumpFilter, ageDays, tally, laneOf, laneChartCheck, copycatOf, buildKnownTickers, normSymbol } from './filters.js';
import { pumpPlan, loadPullbacks } from './pump.js';
import { loadHolders } from './holders-job.js';
import { recordAlert, updateScorecard, summarize } from './scorecard.js';
import { ethPriceFrom, recordEth, ethContext, ownMove, isEthPaired } from './eth.js';
import { classify } from './utility.js';
import fs from 'node:fs';
import path from 'node:path';
import { tagNarratives, clusterLeaders, rotationSignal } from './narrative.js';
import { chartFeatures, holderTrend, scoreCoin, regime as computeRegime } from './score.js';
import { communitySignals } from './community.js';
import { openPosition, updatePositions, equity, stats, planFor } from './paper.js';
import { loadState, saveState, appendCsv, SNAPSHOT_COLUMNS, TRADE_COLUMNS, DATA_DIR } from './store.js';
import { notify } from './notify.js';
import { httpErrors, httpStats, resetBreakers } from './http.js';
import { loadWallets, saveWallets, ingestTrades, resolveOutcomes, flowFeatures, smartWallets } from './wallets.js';
import { alertMessage, tradeMessage, digestMessage, checkMessage, pumpMessage, ignitionMessage } from './messages.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const log = (...a) => console.log(new Date().toISOString(), ...a);

function addPools(byToken, pools) {
  for (const p of pools) {
    const t = p.baseToken.address;
    if (!t || CONFIG.ignoreSymbols.includes((p.baseToken.symbol || '').toUpperCase())) continue;
    if (CONFIG.excludeNamePattern.test(`${p.baseToken.name || ''} ${p.baseToken.symbol || ''}`)) continue;
    const cur = byToken.get(t);
    // keep the deepest pool per token, but remember every pool address (for holder exclusion)
    const all = [...new Set([...(cur?.allPools || []), p.poolAddress])];
    if (!cur || (p.liquidityUsd ?? 0) > (cur.liquidityUsd ?? 0)) byToken.set(t, { ...p, allPools: all });
    else cur.allPools = all;
  }
}

// Every ~2h: pull the chain's tokens by holder count and map each to its main pool.
async function discover(state, now) {
  if (state.lastDiscoverAt && now - state.lastDiscoverAt < CONFIG.scan.discoverEveryMin * MIN) return;
  state.lastDiscoverAt = now;
  let tokens;
  state.lastDiscovery = { at: new Date(now).toISOString() };
  try {
    tokens = await bs.listTokensByHolders(CONFIG.scan.discoverPages);
  } catch (e) {
    log('discovery (Blockscout token list) failed:', e.message);
    state.lastDiscovery.error = e.message.slice(0, 200);
    return;
  }
  state.lastDiscovery.listed = tokens.length;
  // Established tickers (5k+ holders) — anything else using the same ticker is a copycat
  const tickers = {};
  for (const t of [...tokens].sort((a, b) => b.holders - a.holders)) {
    if (t.holders < CONFIG.copycatMinHolders || !t.symbol) continue;
    const k = normSymbol(t.symbol);
    if ((tickers[k] ||= []).length < 3) tickers[k].push(t.address);
  }
  state.knownTickers = tickers;
  state.lastDiscovery.sample = tokens.slice(0, 5).map((t) => `${t.symbol}:${t.holders}`);
  const fresh = tokens.filter(
    (t) =>
      t.holders >= CONFIG.community.minHolders &&
      !CONFIG.ignoreSymbols.includes((t.symbol || '').toUpperCase()) &&
      !CONFIG.excludeNamePattern.test(`${t.name || ''} ${t.symbol || ''}`) &&
      !state.universe[t.address] &&
      !(state.noPool?.[t.address] && now - state.noPool[t.address] < DAY) // no trading pool last time we asked
  );
  let pools = {};
  let lookupOk = false;
  try {
    pools = await gecko.topPoolsFor(fresh.map((t) => t.address));
    lookupOk = true;
  } catch (e) {
    state.lastDiscovery.poolLookupError = e.message.slice(0, 160);
    log('discovery (pool lookup) failed:', e.message);
  }
  state.noPool ||= {};
  for (const t of fresh) {
    if (pools[t.address]) state.universe[t.address] = { pool: pools[t.address], symbol: t.symbol, at: now };
    else if (lookupOk) state.noPool[t.address] = now; // only trust "no pool" when the lookup itself worked
  }
  for (const [a, at] of Object.entries(state.noPool)) if (now - at > DAY) delete state.noPool[a];
  state.lastDiscovery.fresh = fresh.length;
  state.lastDiscovery.withPools = Object.keys(pools).length;
  const u = Object.entries(state.universe).sort((a, b) => b[1].at - a[1].at).slice(0, CONFIG.scan.universeMax);
  state.universe = Object.fromEntries(u);
  log(`discovery: ${tokens.length} tokens by holders → ${Object.keys(pools).length} new pools · universe ${u.length}`);
}

async function scanPools(state) {
  const byToken = new Map();
  for (const sort of CONFIG.scan.sorts) {
    const pages = Math.min(CONFIG.scan.pagesPerSort, CONFIG.scan.pagesBySort?.[sort] ?? CONFIG.scan.pagesPerSort);
    for (let page = 1; page <= pages; page++) {
      let pools;
      try {
        pools = await gecko.listPools(sort, page);
      } catch (e) {
        log(`pool list ${sort} p${page} failed: ${e.message}`);
        break;
      }
      if (!pools.length) break;
      addPools(byToken, pools);
    }
  }
  if (CONFIG.scan.includeTrending) {
    try {
      addPools(byToken, await gecko.trendingPools(1));
    } catch (e) {
      log('trending failed:', e.message);
    }
  }
  // Watchlist + discovered universe: re-checked even when they're not on the top lists
  const missing = [...new Set(
    [...Object.entries(state.watchlist), ...Object.entries(state.universe)]
      .filter(([t]) => !byToken.has(t))
      .map(([, w]) => w.pool)
  )];
  if (missing.length) {
    try {
      addPools(byToken, await gecko.poolsMulti(missing));
    } catch (e) {
      log('watchlist refresh failed:', e.message);
    }
  }
  // Robinhood Stock Tokens show up as the *quote* side of stock-paired pools — never treat them as memecoins
  const quotes = new Set();
  for (const p of byToken.values()) {
    const q = (p.quoteToken.symbol || '').toUpperCase();
    if (p.quoteToken.address && !CONFIG.ignoreSymbols.includes(q)) quotes.add(p.quoteToken.address);
  }
  for (const q of quotes) byToken.delete(q);
  return [...byToken.values()];
}

async function priceMapFor(paper, pools) {
  const map = {};
  const byToken = new Map(pools.map((p) => [p.baseToken.address, p]));
  const missing = [];
  for (const pos of paper.positions) {
    const p = byToken.get(pos.token);
    if (p) map[pos.token] = { price: p.priceUsd, liquidityUsd: p.liquidityUsd };
    else missing.push(pos.pool);
  }
  if (missing.length) {
    try {
      for (const p of await gecko.poolsMulti(missing)) {
        map[p.baseToken.address] = { price: p.priceUsd, liquidityUsd: p.liquidityUsd };
      }
    } catch (e) {
      log('price refresh failed:', e.message);
    }
  }
  return map;
}

async function holderData(pool, info, state, now) {
  const token = pool.baseToken.address;
  const hit = state.holderCache[token];
  if (hit && now - hit.at < CONFIG.holderCacheMin * MIN) return { conc: hit.conc, holdersCount: hit.holdersCount, cached: true };
  // the holders job (slow Blockscout calls, every 30 min) — fresh enough within 6h
  const job = (state.holdersFile ||= loadHolders()).coins?.[token];
  if (job?.conc && now - job.at < CONFIG.holdersJob.freshHours * HOUR) return { conc: job.conc, holdersCount: job.holdersCount, cached: true, fromJob: true };
  // Blockscout is slow, so normally only the holders job talks to it; a coin it hasn't
  // reached yet uses the GeckoTerminal estimate (and can't be a buy) until the next job run
  if (!CONFIG.holdersJob.scanFallback || state.health?.bsDown) return { conc: null, holdersCount: null, cached: false };
  const [meta, holders] = await Promise.all([
    bs.tokenMeta(token).catch(() => null),
    bs.topHolders(token).catch(() => []),
  ]);
  if (!meta && !holders.length && state.health) state.health.bsDown = (state.health.bsFails = (state.health.bsFails || 0) + 1) >= 2;
  const conc =
    meta?.totalSupply && holders.length
      ? bs.concentration(holders, meta.totalSupply, { poolAddresses: pool.allPools || [pool.poolAddress], devAddress: info?.devAddress })
      : null;
  const holdersCount = meta?.holders ?? null;
  if (conc) state.holderCache[token] = { at: now, conc, holdersCount };
  return { conc, holdersCount, cached: false };
}

async function burnData(token, state, now) {
  const hit = state.burnCache[token];
  if (hit && now - hit.at < CONFIG.burns.cacheHours * HOUR) return hit;
  const job = (state.holdersFile ||= loadHolders()).coins?.[token];
  if (job?.recentBurns && now - job.at < CONFIG.holdersJob.freshHours * HOUR) return { at: job.at, ...job.recentBurns };
  if (!CONFIG.holdersJob.scanFallback) return null;
  try {
    const r = await bs.recentBurns(token, now - CONFIG.burns.recentDays * DAY);
    state.burnCache[token] = { at: now, ...r };
    return state.burnCache[token];
  } catch {
    return null;
  }
}

async function tradeFlow(pool, w, state, now) {
  const token = pool.baseToken.address;
  const t = w.tokens[token];
  const fresh = t?.fetchedAt && now - t.fetchedAt < CONFIG.wallets.tradeRefreshMin * MIN;
  if (fresh || state.health.tradePulls >= CONFIG.wallets.tradesPerRunMaxPools) return t?.flow || null;
  try {
    const trades = await gecko.poolTrades(pool.poolAddress);
    state.health.tradePulls += 1;
    ingestTrades(w, token, pool.baseToken.symbol, trades, now);
    const flow = flowFeatures(trades, w);
    w.tokens[token].fetchedAt = now;
    w.tokens[token].flow = flow;
    return flow;
  } catch (e) {
    log(`trades ${pool.baseToken.symbol} failed: ${e.message}`);
    return t?.flow || null;
  }
}

async function deepCheck(pool, state, leaders, now, w, { force = false, catalysts = {}, lane: laneOverride = null } = {}) {
  const token = pool.baseToken.address;
  const lane = laneOverride || laneOf(pool.marketCap);
  const info = await cachedInfo(token, state, now);
  const hd = await holderData(pool, info, state, now);
  let conc = hd.conc;
  if (!conc) conc = bs.estimateConcentration(info, pool); // backup: GeckoTerminal holder split
  state.health.concSource[conc ? (conc.source || (hd.fromJob ? 'holdersJob' : hd.cached ? 'cached' : 'blockscout')) : 'none'] = (state.health.concSource[conc ? (conc.source || (hd.fromJob ? 'holdersJob' : hd.cached ? 'cached' : 'blockscout')) : 'none'] || 0) + 1;
  const holdersCount = hd.holdersCount ?? info?.holders ?? null;

  // Holder history — our own dataset; sampled every ~2h so the 3-day trend means something
  const hist = (state.holders[token] ||= []);
  const holderChangePct = holderTrend(hist, holdersCount, now);
  const last = hist.at(-1);
  if (holdersCount != null && (!last || now - last[0] >= CONFIG.cadence.holderSampleEveryMin * MIN)) {
    hist.push([now, holdersCount]);
  }

  const community = await communitySignals({ pool, info, state, now });
  const filt = deepFilter({ info, holdersCount, conc, community, lane, marketCap: pool.marketCap });
  let chart = null;
  let candles = null;
  let flow = null;
  let burns = null;
  if (filt.ok || force) {
    try {
      candles = await cachedDaily(pool.poolAddress, state, now);
      chart = chartFeatures(candles, pool.priceUsd);
      const laneMiss = laneChartCheck(lane, chart);
      if (laneMiss) {
        filt.reasons.push(laneMiss);
        filt.ok = false;
      }
    } catch {
      filt.warnings.push('chart unavailable');
    }
    flow = await tradeFlow(pool, w, state, now);
    burns = { burnedPct: conc?.source === 'estimate' ? null : conc?.burnedPct ?? null, recent: await burnData(token, state, now) };
    if (flow?.bundledShare >= 0.3) filt.warnings.push(`${Math.round(flow.bundledShare * 100)}% of buys were bundled (several wallets in one block — likely bots)`);
    if (flow?.botBuyers) filt.warnings.push(`${flow.botBuyers} known bot wallet(s) buying`);
    if (flow?.washLikely) filt.warnings.push(`Looks like a volume bot / wash trading (${flow.washSignals.join('; ')}) — activity is likely fake, kept out of the buy zone`);
  }

  // True age = older of pool creation and first candle
  let age = ageDays(pool.createdAt, now);
  if (chart?.firstCandleAt) age = Math.max(age ?? 0, (now - chart.firstCandleAt) / DAY);

  const kind = classify({ info, pool, burns });
  const { tags, stockPaired } = tagNarratives(pool);
  const rotation = rotationSignal(pool, leaders);
  const score = filt.ok || force
    ? scoreCoin({
        pool, holdersCount, conc, socials: filt.socials, chart, holderChangePct, rotation, stockPaired, community, flow, burns,
        lane, catalyst: catalysts[token] || null, info,
        smartBonus: { per: CONFIG.wallets.smartBonusPerWallet, max: CONFIG.wallets.smartBonusMax },
      })
    : null;

  if (lane === 'micro' && score) filt.warnings.push('Micro lane — survivor bounce. Keep size small (≤5% of the wallet); these often fade after the bounce.');
  if (score?.parts.inflatedHoldersPenalty) {
    filt.warnings.push(`Holder count looks padded — only ${usdOf(score.usdPerHolder)} of market cap per holder (airdropped dust wallets?)`);
  }
  return { pool, info, conc, holdersCount, holderChangePct, filt, chart, candles, age, narratives: tags, stockPaired, rotation, score, community, flow, burns, lane, kind: kind.kind, kindWhy: kind.why, eth: state.eth };
}

// Second opinion on price before alerting: DexPaprika vs GeckoTerminal
async function priceCrossCheck(r) {
  const gt = r.pool.priceUsd;
  if (!gt) return;
  try {
    const d = await dp.token(r.pool.baseToken.address);
    if (!d?.price) return;
    const diff = Math.abs(d.price / gt - 1) * 100;
    r.priceCheck = { dexpaprika: d.price, diffPct: diff };
    if (diff > CONFIG.priceCheckMaxDiffPct) {
      r.filt.warnings.push(`Price sources disagree by ${diff.toFixed(0)}% (GeckoTerminal vs DexPaprika) — check the chart before trusting the numbers`);
    }
  } catch {
    /* second opinion unavailable — not a reason to hold the alert */
  }
}

// Token info (socials, holder count, GT score) barely changes — re-use it for 2h
async function cachedInfo(token, state, now) {
  state.infoCache ||= {};
  const hit = state.infoCache[token];
  if (hit && now - hit.at < CONFIG.infoCacheMin * MIN) {
    if (state.health?.cacheHits) state.health.cacheHits.info += 1;
    return hit.info;
  }
  const info = await gecko.tokenInfo(token).catch(() => null);
  if (info) state.infoCache[token] = { at: now, info };
  return info;
}

// Daily candles re-used for 1h (stored compactly); today's move comes from the live pool price
async function cachedDaily(poolAddress, state, now) {
  state.chartCache ||= {};
  const hit = state.chartCache[poolAddress];
  if (hit && now - hit.at < CONFIG.chartCacheMin * MIN) {
    if (state.health?.cacheHits) state.health.cacheHits.chart += 1;
    return hit.c.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  }
  const candles = await gecko.ohlcvDaily(poolAddress, 90);
  if (candles?.length) state.chartCache[poolAddress] = { at: now, c: candles.map((k) => [k.t, k.o, k.h, k.l, k.c, k.v]) };
  return candles;
}

// data/catalysts.json — coins you tagged from Telegram (/catalyst 0x… note). Active for N days.
export function loadCatalysts(now = Date.now()) {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalysts.json'), 'utf8')).coins || {};
    return Object.fromEntries(Object.entries(all).filter(([, v]) => now - Date.parse(v.at) < CONFIG.catalyst.manualDays * DAY));
  } catch {
    return {};
  }
}

// Coins sitting in a quiet base get their hourly volume watched for ignition
function rememberQuietBase(state, r, now) {
  const token = r.pool.baseToken.address;
  const p = r.score?.parts;
  if (!(p?.quietBase || p?.absorption) || r.flow?.washLikely || !r.chart?.baseDailyVol) return;
  state.quietBases[token] = {
    pool: r.pool.poolAddress, symbol: r.pool.baseToken.symbol, lane: r.lane, at: now,
    baseHigh: r.chart.baseHigh, baseHourVol: r.chart.baseDailyVol / 24, drawdownPct: r.chart.drawdownPct,
    volTrend: r.chart.volTrend, score: r.score.total, type: p.absorption ? 'absorption' : 'quiet', kind: r.kind,
  };
}

// Pure check on hourly candles (exported for tests).
// Volume: last N hours vs the coin's own normal hour (median of the earlier candles in the same
// series, so DexPaprika and GeckoTerminal units are never mixed). Price: from the live USD pool
// price when given (movePct/priceNow), else from the candles.
export function ignitionSignal(base, hourly, { priceNow = null, movePct = null } = {}) {
  const g = CONFIG.ignition;
  if (!hourly?.length || hourly.length <= g.hours) return null;
  const win = hourly.slice(-g.hours);
  const earlier = hourly.slice(0, -g.hours).map((c) => c.v);
  const vol = win.reduce((s, c) => s + c.v, 0) / win.length;
  let normal = null;
  if (earlier.length >= 6) {
    const sorted = [...earlier].sort((a, b) => a - b);
    const mean = earlier.reduce((s, v) => s + v, 0) / earlier.length;
    normal = Math.max(sorted[Math.floor(sorted.length / 2)], mean * 0.5); // a few dead hours can't fake a huge multiple
  } else {
    normal = base?.baseHourVol ?? null;
  }
  if (!normal) return null;
  const mult = vol / normal;
  const px = priceNow ?? win.at(-1).c;
  const startPx = win[0].o || win[0].c;
  const move = movePct ?? (px / startPx - 1) * 100;
  const aboveBasePct = base?.baseHigh ? (px / base.baseHigh - 1) * 100 : null;
  const fired = mult >= g.minVolMultiple && move >= 5 && (aboveBasePct == null || aboveBasePct <= g.maxPriceAboveBasePct);
  return { fired, mult, aboveBasePct, movePct: move, price: px };
}

async function checkIgnition(state, poolByToken, candidates, runStats, now, outOfTime = () => false, eth = {}) {
  const g = CONFIG.ignition;
  for (const [t, b] of Object.entries(state.quietBases)) if (now - b.at > g.keepDays * DAY) delete state.quietBases[t];
  for (const [t, v] of Object.entries(state.ignitionAlerts)) if (now - v.at > 3 * DAY) delete state.ignitionAlerts[t];
  const list = Object.entries(state.quietBases)
    .filter(([t]) => !(state.ignitionAlerts[t] && now - state.ignitionAlerts[t].at < g.cooldownHours * HOUR))
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0))
    .slice(0, g.maxChecks);
  for (const [token, base] of list) {
    if (outOfTime()) break;
    const pool = poolByToken.get(token);
    if (pool && (pool.volume24h || 0) < g.minVolume24hUsd) continue;
    // DexPaprika first (own rate limit), GeckoTerminal as backup
    let sig = null;
    if (pool?.priceUsd) {
      try {
        const hourly = await dp.hourly(base.pool, 24);
        sig = ignitionSignal(base, hourly, { priceNow: pool.priceUsd, movePct: ownMove(pool, pool.change.h6 ?? pool.change.h1, pool.change.h6 != null ? eth.h6 : null) });
        if (sig) state.health.ignitionSource.dexpaprika += 1;
      } catch (e) {
        log(`ignition ${base.symbol} (DexPaprika) failed: ${e.message}`);
      }
    }
    if (!sig) {
      try {
        const hourly = await gecko.ohlcv(base.pool, 'hour', { limit: 24 });
        sig = ignitionSignal(base, hourly, { priceNow: pool?.priceUsd ?? null });
        if (sig) state.health.ignitionSource.gecko += 1;
      } catch (e) {
        log(`ignition ${base.symbol} candles failed: ${e.message}`);
        continue;
      }
    }
    if (!sig?.fired) continue;
    log(`🔥 ignition ${base.symbol}: ${sig.mult.toFixed(1)}× hourly volume`);
    const mcap = pool?.marketCap ?? null;
    await notify(ignitionMessage({ token, base, sig, pool }), { buttons: paperButtons(token) });
    state.ignitionAlerts[token] = { at: now, symbol: base.symbol };
    state.scorecard ||= [];
    recordAlert(state.scorecard, { token, symbol: base.symbol, tier: 'ignition', lane: base.lane, price: sig.price, score: base.score, kind: base.kind, ethTrend: eth.trend, mcap: pool?.marketCap ?? null, pool: base.pool }, now);
    candidates.push({
      token, symbol: base.symbol, pool: base.pool, tier: 'ignition', score: base.score ?? null, price: sig.price,
      mcap, liquidity: pool?.liquidityUsd ?? null, change24h: pool?.change.h24 ?? null, washLikely: false, lane: base.lane,
      at: new Date(now).toISOString(),
    });
    runStats.ignition += 1;
  }
}

const usdOf = (v) => (v == null ? '—' : `$${v.toFixed(2)}`);

function shouldAlert(store, token, score, cooldownH, now) {
  const prev = store[token];
  if (!prev) return true;
  if (now - prev.at >= cooldownH * HOUR) return true;
  return score >= prev.score + CONFIG.realertScoreJump;
}

export async function main() {
  resetBreakers();
  const now = Date.now();
  const state = loadState();
  // Two clocks trigger scans (Cloudflare cron + GitHub's own schedule). If GitHub's
  // backup schedule fires right after a scan already ran, skip it.
  const lastAt = state.lastRun?.at ? Date.parse(state.lastRun.at) : 0;
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && now - lastAt < CONFIG.minMinutesBetweenScheduledScans * MIN) {
    log(`skipping: last scan was ${Math.round((now - lastAt) / MIN)} min ago`);
    return { skipped: true };
  }
  state.holderCache ||= {};
  state.burnCache ||= {};
  state.pumpAlerts ||= {};
  state.quietBases ||= {};
  state.ignitionAlerts ||= {};
  const catalysts = loadCatalysts(now);
  const w = loadWallets();
  state.runs = (state.runs || 0) + 1;
  const snapshots = [];
  const runStats = { scanned: 0, quickPass: 0, deepPass: 0, buy: 0, watch: 0, pump: 0, ignition: 0, quality: 0, micro: 0 };
  const candidates = [];
  const reasons = {};
  let reg = { state: 'neutral', ratio: null };
  let prices = {};
  let lastPools = [];

  try {
    // 1. Discover + scan
    state.health = { concSource: { blockscout: 0, cached: 0, estimate: 0, none: 0 }, tradePulls: 0, ignitionSource: { dexpaprika: 0, gecko: 0 }, cacheHits: { info: 0, chart: 0 } };
    let lastMark = now;
    state.health.phases = {};
    const mark = (name) => {
      state.health.phases[name] = Math.round((Date.now() - lastMark) / 1000);
      lastMark = Date.now();
    };
    await discover(state, now);
    const pools = await scanPools(state);
    lastPools = pools;
    runStats.scanned = pools.length;
    // ETH context: price from WETH-paired pools (free), trend from our own history
    const ethPx = ethPriceFrom(pools);
    state.eth = ethContext(state, ethPx, now);
    recordEth(state, ethPx, now);
    const eth = state.eth;
    // filters judge a WETH-paired coin on its OWN move — ETH ripping isn't the coin pumping
    const ownView = (p) => (eth.h24 == null || !isEthPaired(p) ? p : { ...p, change: { ...p.change, h24: ownMove(p, p.change.h24, eth.h24) } });
    log(`scanned ${pools.length} tokens on ${CONFIG.network}`);
    if (!pools.length) throw new Error('no pools returned — API down or network id changed');

    mark('discover+lists');
    // 2. Market regime (sampled every ~2h so the median spans days, not hours)
    const totalVol = pools.reduce((s, p) => s + (p.volume24h || 0), 0);
    reg = computeRegime(state.volumeHistory, totalVol);
    const lastVol = state.volumeHistory.at(-1);
    if (!lastVol || now - lastVol.t >= CONFIG.cadence.regimeSampleEveryMin * MIN) state.volumeHistory.push({ t: now, v: totalVol });
    const delta = reg.state === 'risk-on' ? CONFIG.regimeAdjust.riskOn : reg.state === 'risk-off' ? CONFIG.regimeAdjust.riskOff : 0;
    const buyBar = CONFIG.alertScore + delta;
    const watchBar = CONFIG.watchScore + delta;
    log(`regime ${reg.state}${reg.ratio ? ` (${reg.ratio.toFixed(2)}×)` : ''} → buy ≥${buyBar}, watch ≥${watchBar}`);

    // 3. Mark paper positions + every tracked wallet buy to market
    prices = await priceMapFor(state.paper, pools);
    const allPrices = Object.fromEntries(pools.filter((p) => p.priceUsd).map((p) => [p.baseToken.address, p.priceUsd]));
    const resolved = resolveOutcomes(w, allPrices, now);
    state.scorecard ||= [];
    for (const a of updateScorecard(state.scorecard, allPrices, now)) {
      log(`scorecard: $${a.symbol} ${a.tier} alert → ${a.outcome} (peak ${a.peakX.toFixed(2)}×)`);
    }
    if (resolved.length) log(`wallet buys resolved: ${resolved.filter((r) => r.r === 'W').length} wins, ${resolved.filter((r) => r.r === 'L').length} losses`);
    for (const ev of CONFIG.paper.auto ? updatePositions(state.paper, prices, now) : []) {
      await notify(tradeMessage(ev));
      if (ev.type === 'closed') {
        const r = ev.record;
        appendCsv('trades.csv', TRADE_COLUMNS, [{
          ...r, closedAt: new Date(r.closedAt).toISOString(), openedAt: new Date(r.openedAt).toISOString(),
          sizeUsd: r.sizeUsd.toFixed(2), realized: r.realized.toFixed(2), pnl: r.pnl.toFixed(2), multiple: r.multiple.toFixed(3),
        }]);
      }
    }

    mark('paper+wallets');
    // 4. Quick junk filter
    const leaders = clusterLeaders(pools);
    const known = buildKnownTickers(state.knownTickers);
    const quick = [];
    for (const p of pools) {
      const q = quickFilter(ownView(p), now);
      const copy = copycatOf(p, known);
      if (copy) {
        q.ok = false;
        q.reasons.push('copycat ticker');
      }
      const t = p.baseToken.address;
      if (q.ok) {
        quick.push(p);
        state.watchlist[t] = { pool: p.poolAddress, symbol: p.baseToken.symbol, at: now };
      } else {
        tally(reasons, q.reasons);
        // drop from watchlist after 3 days of failing
        if (state.watchlist[t] && now - state.watchlist[t].at > 3 * DAY) delete state.watchlist[t];
      }
      if ((p.marketCap ?? Infinity) <= CONFIG.snapshotMaxMarketCap) {
        snapshots.push(snapRow(p, now, { ageDays: q.ageDays, decision: q.ok ? 'quick-pass' : 'rejected', reasons: q.reasons.join('; ') }));
      }
    }
    // cap watchlist size (keep most recent)
    const wl = Object.entries(state.watchlist).sort((a, b) => b[1].at - a[1].at);
    state.watchlist = Object.fromEntries(wl.slice(0, CONFIG.scan.watchlistMax));

    runStats.quickPass = quick.length;
    quick.sort((a, b) => b.buyers24h - a.buyers24h);
    const toCheck = quick.slice(0, CONFIG.scan.maxDeepChecks);
    log(`${quick.length} passed quick filter, deep-checking ${toCheck.length}`);

    // 5. Deep check + score + alert (any hour of the day)
    const outOfTime = () => Date.now() - now > CONFIG.scan.timeBudgetMin * MIN;
    for (const pool of toCheck) {
      if (outOfTime()) {
        log('time budget reached — skipping the remaining deep checks');
        state.health.outOfTime = true;
        break;
      }
      let r;
      try {
        r = await deepCheck(pool, state, leaders, now, w, { catalysts });
      } catch (e) {
        log(`deep check ${pool.baseToken.symbol} failed: ${e.message}`);
        continue;
      }
      const row = snapshots.find((s) => s.token === pool.baseToken.address);
      if (row) Object.assign(row, deepRow(r));

      if (!r.filt.ok) {
        tally(reasons, r.filt.reasons);
        log(`✗ ${pool.baseToken.symbol}: ${r.filt.reasons.join('; ')}`);
        continue;
      }
      runStats.deepPass += 1;
      runStats[r.lane] += 1;
      rememberQuietBase(state, r, now);
      const s = r.score.total;
      candidates.push(candidateRow(r, s >= buyBar && !r.score.buyBlocked ? 'buy' : s >= watchBar ? 'watch' : 'scored', now));
      log(`✓ ${pool.baseToken.symbol}: score ${s}`);
      const token = pool.baseToken.address;

      if (s >= buyBar && !r.score.buyBlocked && shouldAlert(state.alerts, token, s, CONFIG.realertCooldownHours, now)) {
        const paperOpened = CONFIG.paper.auto
          ? openPosition(state.paper, { token, symbol: pool.baseToken.symbol, pool: pool.poolAddress, price: pool.priceUsd, score: s }, now)
          : null;
        await priceCrossCheck(r);
        await notify(alertMessage({ ...r, tier: 'buy', plan: planFor(pool.priceUsd), regime: reg, warnings: r.filt.warnings, paperOpened }), { buttons: paperButtons(token) });
        recordAlert(state.scorecard, { token, symbol: pool.baseToken.symbol, tier: 'buy', lane: r.lane, price: pool.priceUsd, score: s, kind: r.kind, ethTrend: eth.trend, mcap: pool.marketCap, pool: pool.poolAddress }, now);
        state.alerts[token] = { at: now, score: s, symbol: pool.baseToken.symbol };
        runStats.buy += 1;
        if (row) row.decision = 'BUY-ALERT';
      } else if (s >= watchBar && (s < buyBar || r.score.buyBlocked) && shouldAlert(state.watchAlerts, token, s, CONFIG.watchCooldownHours, now)) {
        await priceCrossCheck(r);
        await notify(alertMessage({ ...r, tier: 'watch', plan: planFor(pool.priceUsd), regime: reg, warnings: r.filt.warnings }), { buttons: paperButtons(token) });
        recordAlert(state.scorecard, { token, symbol: pool.baseToken.symbol, tier: 'watch', lane: r.lane, price: pool.priceUsd, score: s, kind: r.kind, ethTrend: eth.trend, mcap: pool.marketCap, pool: pool.poolAddress }, now);
        state.watchAlerts[token] = { at: now, score: s, symbol: pool.baseToken.symbol };
        runStats.watch += 1;
        if (row) row.decision = 'WATCH-ALERT';
      }
    }

    mark('deepChecks');
    // 5b. Coins already pumping: pullback odds + entry zone (don't chase)
    const pullStats = loadPullbacks();
    const pumping = pools
      .map((p) => ({ p, f: pumpFilter(ownView(p), now) }))
      .filter((x) => x.f.ok && !copycatOf(x.p, known))
      .sort((a, b) => b.p.buyers24h - a.p.buyers24h)
      .slice(0, CONFIG.scan.maxPumpChecks);
    for (const { p, f } of pumping) {
      if (outOfTime()) break;
      const token = p.baseToken.address;
      const prev = state.pumpAlerts[token];
      if (prev && now - prev.at < CONFIG.pump.cooldownHours * HOUR) continue;
      let r;
      try {
        r = await deepCheck(p, state, leaders, now, w, { force: true, catalysts, lane: laneOf(f.baseMcap) }); // judged on its pre-pump size
      } catch (e) {
        log(`pump check ${p.baseToken.symbol} failed: ${e.message}`);
        continue;
      }
      if (!r.filt.ok || r.flow?.washLikely) {
        log(`✗ pump ${p.baseToken.symbol}: ${r.flow?.washLikely ? 'wash trading' : r.filt.reasons.join('; ')}`);
        continue;
      }
      const plan = pumpPlan({ pool: p, candles: r.candles, stats: pullStats });
      if (!plan) continue;
      candidates.push({ ...candidateRow(r, 'pump', now), entry: { top: plan.entryTop, mid: plan.entryMid, deep: plan.entryDeep, stop: plan.stop } });
      await notify(pumpMessage({ ...r, plan, baseMcap: f.baseMcap }), { buttons: [[
        { text: `📝 Paper limit buy @ ${fmtPx(plan.entryMid)}`, data: `pl:${token}` },
        { text: '📝 Buy now', data: `pc:${token}` },
      ]] });
      state.pumpAlerts[token] = { at: now, symbol: p.baseToken.symbol };
      recordAlert(state.scorecard, { token, symbol: p.baseToken.symbol, tier: 'pump', lane: r.lane, price: p.priceUsd, score: r.score?.total, kind: r.kind, ethTrend: eth.trend, mcap: p.marketCap, pool: p.poolAddress }, now);
      runStats.pump += 1;
    }

    mark('pumps');
    // 5c. 🔥 IGNITION: hourly volume exploding out of a quiet base
    const poolByToken = new Map(pools.map((p) => [p.baseToken.address, p]));
    if (!outOfTime()) await checkIgnition(state, poolByToken, candidates, runStats, now, outOfTime, eth);

    mark('ignition');
    // 6. Funnel record + daily digest
    state.funnel24h.push({ t: now, scanned: runStats.scanned, quickPass: runStats.quickPass, deepPass: runStats.deepPass, reasons });
    const due = !state.lastDigestAt || now - state.lastDigestAt >= (CONFIG.digestEveryHours * 60 - 5) * MIN;
    if (due) {
      const recent = state.funnel24h.filter((f) => now - f.t < DAY);
      const n = recent.length || 1;
      const avg = (k) => Math.round(recent.reduce((s, f) => s + f[k], 0) / n);
      const reasonSum = {};
      for (const f of recent) for (const [k, v] of Object.entries(f.reasons)) reasonSum[k] = (reasonSum[k] || 0) + v;
      for (const k of Object.keys(reasonSum)) reasonSum[k] = Math.round(reasonSum[k] / n);
      const count = (store) => Object.values(store).filter((a) => now - a.at < DAY).length;
      await notify(digestMessage({
        paper: state.paper, eq: equity(state.paper, prices), stats: stats(state.paper), regime: reg,
        funnel: { runs: recent.length, scanned: avg('scanned'), quickPass: avg('quickPass'), deepPass: avg('deepPass'), reasons: reasonSum },
        buy24h: count(state.alerts), watch24h: count(state.watchAlerts),
        scorecard: summarize(state.scorecard),
        eth,
        sinceLast: state.lastDigestAt
          ? { hours: Math.round((now - state.lastDigestAt) / HOUR), buy: Object.values(state.alerts).filter((a) => a.at > state.lastDigestAt).length, watch: Object.values(state.watchAlerts).filter((a) => a.at > state.lastDigestAt).length }
          : null,
      }));
      state.lastDigestAt = now;
    }

    const topCuts = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(' · ');
    log(`cut reasons: ${topCuts || 'none'}`);
    state.lastRun = {
      at: new Date(now).toISOString(), ...runStats, regime: reg.state,
      universe: Object.keys(state.universe).length, watchlist: Object.keys(state.watchlist).length,
      topCuts: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)),
      holderData: state.health.concSource, cacheHits: state.health.cacheHits, ignitionSource: state.health.ignitionSource,
      http: Object.fromEntries(Object.entries(httpStats).map(([h, v]) => [h.split('.').slice(-2, -1)[0] || h, { calls: v.calls, sec: Math.round(v.ms / 1000), waitSec: Math.round(v.waitMs / 1000), backoffSec: Math.round(v.backoffMs / 1000), r429: v.r429 }])),
      phases: state.health.phases,
      scorecard: summarize(state.scorecard || []),
      eth: state.eth,
      httpErrors, outOfTime: Boolean(state.health.outOfTime), seconds: Math.round((Date.now() - now) / 1000),
      blockscout: { key: bs.hasKey(), calls: bs.usage.calls },
      quietBases: Object.keys(state.quietBases).length,
      knownTickers: Object.keys(state.knownTickers || {}).length,
      catalysts: Object.keys(catalysts).length,
      wallets: { tracked: Object.keys(w.wallets).length, smart: smartWallets(w).length, seeded: Object.keys(w.seeded).length, tradePulls: state.health.tradePulls },
    };
    log(`done: ${runStats.buy} buy-zone, ${runStats.watch} watch alert(s)`);
  } finally {
    // Research dataset: one row per coin per hour (not every 15-min run)
    if (!state.lastSnapshotAt || now - state.lastSnapshotAt >= (CONFIG.cadence.snapshotEveryMin - 2) * MIN) {
      const month = new Date(now).toISOString().slice(0, 7);
      appendCsv(`snapshots/v2-${month}.csv`, SNAPSHOT_COLUMNS, snapshots);
      if (snapshots.length) state.lastSnapshotAt = now;
    }
    // holder cache: drop stale entries
    for (const [t, v] of Object.entries(state.holderCache)) if (now - v.at > 6 * HOUR) delete state.holderCache[t];
    for (const [t, v] of Object.entries(state.burnCache)) if (now - v.at > 24 * HOUR) delete state.burnCache[t];
    for (const [t, v] of Object.entries(state.infoCache || {})) if (now - v.at > CONFIG.infoCacheMin * MIN) delete state.infoCache[t];
    for (const [t, v] of Object.entries(state.chartCache || {})) if (now - v.at > CONFIG.chartCacheMin * MIN) delete state.chartCache[t];
    saveWallets(w, now);
    saveCandidates(candidates, now);
    if (lastPools.length) savePrices(lastPools, now);
    for (const [t, v] of Object.entries(state.pumpAlerts)) if (now - v.at > 3 * DAY) delete state.pumpAlerts[t];
    delete state.holdersFile; // read-only copy of data/holders.json, never saved into state
    saveState(state);
  }
  return runStats;
}

const fmtPx = (v) => (v == null ? '—' : v >= 1 ? `$${v.toFixed(4)}` : `$${v.toPrecision(3)}`);
const paperButtons = (token) => [[{ text: '📝 Paper buy', data: `pc:${token}` }, { text: '📋 Paper menu', data: 'm' }]];

function candidateRow(r, tier, now) {
  const p = r.pool;
  return {
    token: p.baseToken.address, symbol: p.baseToken.symbol, pool: p.poolAddress, tier,
    score: r.score?.total ?? null, price: p.priceUsd, mcap: p.marketCap, liquidity: p.liquidityUsd,
    change24h: p.change.h24, washLikely: Boolean(r.flow?.washLikely), lane: r.lane || laneOf(p.marketCap), kind: r.kind || null, at: new Date(now).toISOString(),
  };
}

// data/candidates.json — what the Telegram paper-trading menu offers under "Place trade".
// Keeps the latest entry per coin from the last 24h.
function saveCandidates(fresh, now) {
  const file = path.join(DATA_DIR, 'candidates.json');
  let prev = [];
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8')).coins || [];
  } catch { /* first run */ }
  const byToken = new Map();
  for (const c of [...prev, ...fresh]) if (now - Date.parse(c.at) < DAY) byToken.set(c.token, c);
  const order = { ignition: 0, buy: 1, pump: 2, watch: 3, scored: 4 };
  const coins = [...byToken.values()].sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9) || (b.score ?? 0) - (a.score ?? 0));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString(), coins }, null, 1));
}

// data/prices.json — every scanned coin's price, for the Telegram paper menu when its own
// price lookups get rate-limited (Cloudflare's shared IPs often hit GeckoTerminal's 429)
function savePrices(pools, now) {
  const p = {};
  for (const x of pools) {
    if (x.priceUsd > 0) p[x.baseToken.address] = [x.priceUsd, Math.round(x.marketCap || 0), Math.round(x.liquidityUsd || 0), x.poolAddress];
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'prices.json'), JSON.stringify({ at: new Date(now).toISOString(), p }));
}

function walletSummary(w) {
  let wins = 0, losses = 0, open = 0;
  for (const v of Object.values(w.wallets)) {
    wins += v.wins;
    losses += v.losses;
    open += v.buys.filter((b) => !b.r).length;
  }
  return { tracked: Object.keys(w.wallets).length, smart: smartWallets(w).length, seeded: Object.keys(w.seeded).length, wins, losses, open };
}

function snapRow(p, now, extra) {
  return {
    ts: new Date(now).toISOString(),
    token: p.baseToken.address,
    symbol: p.baseToken.symbol,
    pool: p.poolAddress,
    quote: p.quoteToken.symbol,
    priceUsd: p.priceUsd,
    marketCap: p.marketCap != null ? Math.round(p.marketCap) : null,
    liquidityUsd: p.liquidityUsd != null ? Math.round(p.liquidityUsd) : null,
    ageDays: extra.ageDays != null ? extra.ageDays.toFixed(1) : null,
    volume24h: Math.round(p.volume24h),
    buyers24h: p.buyers24h,
    sellers24h: p.sellers24h,
    change24h: p.change.h24,
    narratives: tagNarratives(p).tags.join('|'),
    sentimentPos: p.sentimentPos,
    susReports: p.susReports,
    decision: extra.decision,
    reasons: extra.reasons,
  };
}

function deepRow(r) {
  const f = (v, d = 2) => (v == null || Number.isNaN(v) ? null : Number(v).toFixed(d));
  return {
    holders: r.holdersCount,
    top1Pct: f(r.conc?.top1Pct),
    top10Pct: f(r.conc?.top10Pct),
    devPct: f(r.conc?.devPctOnchain ?? r.info?.devPct),
    drawdownPct: f(r.chart?.drawdownPct, 1),
    baseRange: f(r.chart?.baseRange),
    volRatio: f(r.score?.volRatio),
    holderChange3d: f(r.holderChangePct, 1),
    ageDays: f(r.age, 1),
    xHandle: r.community?.x,
    xShared: r.community?.xShared,
    tgMembers: r.community?.tgMembers,
    gtScore: f(r.community?.gtScore, 0),
    score: r.score?.total ?? null,
    decision: r.filt.ok ? 'scored' : 'rejected',
    reasons: r.filt.ok ? r.filt.warnings.join('; ') : r.filt.reasons.join('; '),
  };
}

// /check <CA> from Telegram: full analysis of one coin, even if it fails the filters.
// Read-only — no paper trades, no state saved.
export async function checkCoin(ca, now = Date.now()) {
  resetBreakers();
  const addr = String(ca || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    await notify(`🔍 CHECK — "${ca}" isn't a valid contract address. Send it like:\n/check 0x1234…abcd`);
    return null;
  }
  const state = loadState();
  state.holderCache ||= {};
  state.burnCache ||= {};
  state.health = { concSource: { blockscout: 0, cached: 0, estimate: 0, none: 0 }, tradePulls: 0 };
  const w = loadWallets();
  const poolMap = await gecko.topPoolsFor([addr]).catch(() => ({}));
  const poolAddr = poolMap[addr];
  const [pool] = poolAddr ? await gecko.poolsMulti([poolAddr]).catch(() => []) : [];
  if (!pool) {
    await notify(`🔍 CHECK — couldn't find a trading pool for ${addr} on Robinhood Chain (GeckoTerminal). It may be too new, unlisted, or on another chain.`);
    return null;
  }
  pool.allPools = [pool.poolAddress];
  const q = quickFilter(pool, now);
  const copy = copycatOf(pool, buildKnownTickers(state.knownTickers));
  if (copy) q.reasons.push(copy);
  const r = await deepCheck(pool, state, clusterLeaders([pool]), now, w, { force: true, catalysts: loadCatalysts(now) });
  // the chart gives the true age; drop the age failure if the coin is actually old enough
  const quickReasons = q.reasons.filter((x) => !(x.startsWith('younger than') && r.age >= CONFIG.minAgeDays));
  const failed = [...quickReasons, ...r.filt.reasons];
  const s = r.score?.total ?? 0;
  const tier = failed.length ? 'none' : s >= CONFIG.alertScore && !r.score.buyBlocked ? 'buy' : s >= CONFIG.watchScore ? 'watch' : 'none';
  await notify(checkMessage({ ...r, failed, verdict: tier, plan: planFor(pool.priceUsd), regime: { state: 'neutral' }, warnings: r.filt.warnings }));
  return { failed, score: s, tier };
}

if (process.env.CHECK_CA && import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  checkCoin(process.env.CHECK_CA).catch(async (e) => {
    console.error(e);
    await notify(`🔍 CHECK failed: ${e.message.slice(0, 200)}`);
    process.exit(1);
  });
} else if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
