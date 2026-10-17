// HOOD SCANNER — one run: scan → filter → score → alert → paper trade → log.
// Runs every 15 minutes on GitHub Actions (free on a public repo). Locally: `npm run scan`.
import { pathToFileURL } from 'node:url';
import { CONFIG } from '../config.js';
import * as gecko from './gecko.js';
import * as bs from './blockscout.js';
import { quickFilter, deepFilter, ageDays, tally } from './filters.js';
import { tagNarratives, clusterLeaders, rotationSignal } from './narrative.js';
import { chartFeatures, holderTrend, scoreCoin, regime as computeRegime } from './score.js';
import { communitySignals } from './community.js';
import { openPosition, updatePositions, equity, stats, planFor } from './paper.js';
import { loadState, saveState, appendCsv, SNAPSHOT_COLUMNS, TRADE_COLUMNS } from './store.js';
import { notify } from './notify.js';
import { httpErrors } from './http.js';
import { loadWallets, saveWallets, ingestTrades, resolveOutcomes, flowFeatures, smartWallets } from './wallets.js';
import { alertMessage, tradeMessage, digestMessage, checkMessage } from './messages.js';

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
  state.lastDiscovery.sample = tokens.slice(0, 5).map((t) => `${t.symbol}:${t.holders}`);
  const fresh = tokens.filter(
    (t) =>
      t.holders >= CONFIG.community.minHolders &&
      !CONFIG.ignoreSymbols.includes((t.symbol || '').toUpperCase()) &&
      !CONFIG.excludeNamePattern.test(`${t.name || ''} ${t.symbol || ''}`) &&
      !state.universe[t.address]
  );
  let pools = {};
  try {
    pools = await gecko.topPoolsFor(fresh.map((t) => t.address));
  } catch (e) {
    log('discovery (pool lookup) failed:', e.message);
  }
  for (const t of fresh) if (pools[t.address]) state.universe[t.address] = { pool: pools[t.address], symbol: t.symbol, at: now };
  state.lastDiscovery.fresh = fresh.length;
  state.lastDiscovery.withPools = Object.keys(pools).length;
  const u = Object.entries(state.universe).sort((a, b) => b[1].at - a[1].at).slice(0, CONFIG.scan.universeMax);
  state.universe = Object.fromEntries(u);
  log(`discovery: ${tokens.length} tokens by holders → ${Object.keys(pools).length} new pools · universe ${u.length}`);
}

async function scanPools(state) {
  const byToken = new Map();
  for (const sort of CONFIG.scan.sorts) {
    for (let page = 1; page <= CONFIG.scan.pagesPerSort; page++) {
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
  const [meta, holders] = await Promise.all([
    bs.tokenMeta(token).catch(() => null),
    bs.topHolders(token).catch(() => []),
  ]);
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

async function deepCheck(pool, state, leaders, now, w, { force = false } = {}) {
  const token = pool.baseToken.address;
  const info = await gecko.tokenInfo(token).catch(() => null);
  const hd = await holderData(pool, info, state, now);
  let conc = hd.conc;
  if (!conc) conc = bs.estimateConcentration(info, pool); // backup: GeckoTerminal holder split
  state.health.concSource[conc ? (conc.source || (hd.cached ? 'cached' : 'blockscout')) : 'none'] += 1;
  const holdersCount = hd.holdersCount ?? info?.holders ?? null;

  // Holder history — our own dataset; sampled every ~2h so the 3-day trend means something
  const hist = (state.holders[token] ||= []);
  const holderChangePct = holderTrend(hist, holdersCount, now);
  const last = hist.at(-1);
  if (holdersCount != null && (!last || now - last[0] >= CONFIG.cadence.holderSampleEveryMin * MIN)) {
    hist.push([now, holdersCount]);
  }

  const community = await communitySignals({ pool, info, state, now });
  const filt = deepFilter({ info, holdersCount, conc, community });
  let chart = null;
  let flow = null;
  let burns = null;
  if (filt.ok || force) {
    try {
      chart = chartFeatures(await gecko.ohlcvDaily(pool.poolAddress, 90), pool.priceUsd);
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

  const { tags, stockPaired } = tagNarratives(pool);
  const rotation = rotationSignal(pool, leaders);
  const score = filt.ok || force
    ? scoreCoin({
        pool, holdersCount, conc, socials: filt.socials, chart, holderChangePct, rotation, stockPaired, community, flow, burns,
        smartBonus: { per: CONFIG.wallets.smartBonusPerWallet, max: CONFIG.wallets.smartBonusMax },
      })
    : null;

  if (score?.parts.inflatedHoldersPenalty) {
    filt.warnings.push(`Holder count looks padded — only ${usdOf(score.usdPerHolder)} of market cap per holder (airdropped dust wallets?)`);
  }
  return { pool, info, conc, holdersCount, holderChangePct, filt, chart, age, narratives: tags, stockPaired, rotation, score, community, flow, burns };
}

const usdOf = (v) => (v == null ? '—' : `$${v.toFixed(2)}`);

function shouldAlert(store, token, score, cooldownH, now) {
  const prev = store[token];
  if (!prev) return true;
  if (now - prev.at >= cooldownH * HOUR) return true;
  return score >= prev.score + CONFIG.realertScoreJump;
}

export async function main() {
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
  const w = loadWallets();
  state.runs = (state.runs || 0) + 1;
  const snapshots = [];
  const runStats = { scanned: 0, quickPass: 0, deepPass: 0, buy: 0, watch: 0 };
  const reasons = {};
  let reg = { state: 'neutral', ratio: null };
  let prices = {};

  try {
    // 1. Discover + scan
    state.health = { concSource: { blockscout: 0, cached: 0, estimate: 0, none: 0 }, tradePulls: 0 };
    await discover(state, now);
    const pools = await scanPools(state);
    runStats.scanned = pools.length;
    log(`scanned ${pools.length} tokens on ${CONFIG.network}`);
    if (!pools.length) throw new Error('no pools returned — API down or network id changed');

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
    if (resolved.length) log(`wallet buys resolved: ${resolved.filter((r) => r.r === 'W').length} wins, ${resolved.filter((r) => r.r === 'L').length} losses`);
    for (const ev of updatePositions(state.paper, prices, now)) {
      await notify(tradeMessage(ev));
      if (ev.type === 'closed') {
        const r = ev.record;
        appendCsv('trades.csv', TRADE_COLUMNS, [{
          ...r, closedAt: new Date(r.closedAt).toISOString(), openedAt: new Date(r.openedAt).toISOString(),
          sizeUsd: r.sizeUsd.toFixed(2), realized: r.realized.toFixed(2), pnl: r.pnl.toFixed(2), multiple: r.multiple.toFixed(3),
        }]);
      }
    }

    // 4. Quick junk filter
    const leaders = clusterLeaders(pools);
    const quick = [];
    for (const p of pools) {
      const q = quickFilter(p, now);
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
    for (const pool of toCheck) {
      let r;
      try {
        r = await deepCheck(pool, state, leaders, now, w);
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
      const s = r.score.total;
      log(`✓ ${pool.baseToken.symbol}: score ${s}`);
      const token = pool.baseToken.address;

      if (s >= buyBar && !r.score.buyBlocked && shouldAlert(state.alerts, token, s, CONFIG.realertCooldownHours, now)) {
        const paperOpened = openPosition(state.paper, {
          token, symbol: pool.baseToken.symbol, pool: pool.poolAddress, price: pool.priceUsd, score: s,
        }, now);
        await notify(alertMessage({ ...r, tier: 'buy', plan: planFor(pool.priceUsd), regime: reg, warnings: r.filt.warnings, paperOpened }));
        state.alerts[token] = { at: now, score: s, symbol: pool.baseToken.symbol };
        runStats.buy += 1;
        if (row) row.decision = 'BUY-ALERT';
      } else if (s >= watchBar && (s < buyBar || r.score.buyBlocked) && shouldAlert(state.watchAlerts, token, s, CONFIG.watchCooldownHours, now)) {
        await notify(alertMessage({ ...r, tier: 'watch', plan: planFor(pool.priceUsd), regime: reg, warnings: r.filt.warnings }));
        state.watchAlerts[token] = { at: now, score: s, symbol: pool.baseToken.symbol };
        runStats.watch += 1;
        if (row) row.decision = 'WATCH-ALERT';
      }
    }

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
      holderData: state.health.concSource, httpErrors,
      blockscout: { key: bs.hasKey(), calls: bs.usage.calls },
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
    saveWallets(w, now);
    saveState(state);
  }
  return runStats;
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
  const r = await deepCheck(pool, state, clusterLeaders([pool]), now, w, { force: true });
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
