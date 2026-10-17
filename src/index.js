// HOOD SCANNER — one run: scan → filter → score → alert → paper trade → log.
// Runs every 2 hours on GitHub Actions (free). Locally: `npm run scan`.
import { pathToFileURL } from 'node:url';
import { CONFIG } from '../config.js';
import * as gecko from './gecko.js';
import * as bs from './blockscout.js';
import { quickFilter, deepFilter, ageDays } from './filters.js';
import { tagNarratives, clusterLeaders, rotationSignal } from './narrative.js';
import { chartFeatures, holderTrend, scoreCoin, regime as computeRegime } from './score.js';
import { openPosition, updatePositions, equity, stats, planFor } from './paper.js';
import { loadState, saveState, appendCsv, SNAPSHOT_COLUMNS, TRADE_COLUMNS } from './store.js';
import { notify } from './notify.js';
import { alertMessage, tradeMessage, digestMessage } from './messages.js';

const HOUR = 3_600_000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function scanPools() {
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
      for (const p of pools) {
        const t = p.baseToken.address;
        if (!t || CONFIG.ignoreSymbols.includes((p.baseToken.symbol || '').toUpperCase())) continue;
        const cur = byToken.get(t);
        // keep the deepest pool per token, but remember every pool address (for holder exclusion)
        const all = [...(cur?.allPools || []), p.poolAddress];
        if (!cur || (p.liquidityUsd ?? 0) > (cur.liquidityUsd ?? 0)) byToken.set(t, { ...p, allPools: all });
        else cur.allPools = all;
      }
    }
  }
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

async function deepCheck(pool, state, leaders, now) {
  const token = pool.baseToken.address;
  const [info, meta, holders] = await Promise.all([
    gecko.tokenInfo(token).catch(() => null),
    bs.tokenMeta(token).catch(() => null),
    bs.topHolders(token).catch(() => []),
  ]);
  const conc =
    meta?.totalSupply && holders.length
      ? bs.concentration(holders, meta.totalSupply, { poolAddresses: pool.allPools || [pool.poolAddress], devAddress: info?.devAddress })
      : null;
  const holdersCount = meta?.holders ?? info?.holders ?? null;

  // holder history (our own dataset — builds conviction signal over time)
  if (holdersCount != null) {
    state.holders[token] ||= [];
    state.holders[token].push([now, holdersCount]);
  }
  const holderChangePct = holderTrend(state.holders[token]?.slice(0, -1), holdersCount, now);

  const filt = deepFilter({ info, holdersCount, conc });
  let chart = null;
  if (filt.ok) {
    try {
      chart = chartFeatures(await gecko.ohlcvDaily(pool.poolAddress, 90), pool.priceUsd);
    } catch (e) {
      filt.warnings.push('chart unavailable');
    }
  }

  // True age = older of pool creation and first candle
  let age = ageDays(pool.createdAt, now);
  if (chart?.firstCandleAt) age = Math.max(age ?? 0, (now - chart.firstCandleAt) / 86_400_000);

  const { tags, stockPaired } = tagNarratives(pool);
  const rotation = rotationSignal(pool, leaders);
  const score = filt.ok
    ? scoreCoin({ pool, holdersCount, conc, socials: filt.socials, chart, holderChangePct, rotation, stockPaired })
    : null;

  return { pool, info, conc, holdersCount, holderChangePct, filt, chart, age, narratives: tags, stockPaired, rotation, score };
}

export async function main() {
  const now = Date.now();
  const state = loadState();
  state.runs = (state.runs || 0) + 1;
  const snapshots = [];
  const runStats = { scanned: 0, quickPass: 0, deepPass: 0, alerts: 0 };

  try {
    // 1. Scan
    const pools = await scanPools();
    runStats.scanned = pools.length;
    log(`scanned ${pools.length} tokens on ${CONFIG.network}`);
    if (!pools.length) throw new Error('no pools returned — API down or network id changed');

    // 2. Market regime
    const totalVol = pools.reduce((s, p) => s + (p.volume24h || 0), 0);
    const reg = computeRegime(state.volumeHistory, totalVol);
    state.volumeHistory.push({ t: now, v: totalVol });
    const threshold =
      CONFIG.alertScore + (reg.state === 'risk-on' ? CONFIG.regimeAdjust.riskOn : reg.state === 'risk-off' ? CONFIG.regimeAdjust.riskOff : 0);
    log(`regime ${reg.state}${reg.ratio ? ` (${reg.ratio.toFixed(2)}×)` : ''} → alert threshold ${threshold}`);

    // 3. Mark paper positions to market
    const prices = await priceMapFor(state.paper, pools);
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
      if (q.ok) quick.push(p);
      if ((p.marketCap ?? Infinity) <= CONFIG.snapshotMaxMarketCap) {
        snapshots.push(snapRow(p, now, { ageDays: q.ageDays, decision: q.ok ? 'quick-pass' : 'rejected', reasons: q.reasons.join('; ') }));
      }
    }
    runStats.quickPass = quick.length;
    quick.sort((a, b) => b.buyers24h - a.buyers24h);
    const toCheck = quick.slice(0, CONFIG.scan.maxDeepChecks);
    log(`${quick.length} passed quick filter, deep-checking ${toCheck.length}`);

    // 5. Deep check + score + alert
    for (const pool of toCheck) {
      let r;
      try {
        r = await deepCheck(pool, state, leaders, now);
      } catch (e) {
        log(`deep check ${pool.baseToken.symbol} failed: ${e.message}`);
        continue;
      }
      const row = snapshots.find((s) => s.token === pool.baseToken.address);
      if (row) Object.assign(row, deepRow(r));

      if (!r.filt.ok) {
        log(`✗ ${pool.baseToken.symbol}: ${r.filt.reasons.join('; ')}`);
        continue;
      }
      runStats.deepPass += 1;
      log(`✓ ${pool.baseToken.symbol}: score ${r.score.total}`);
      if (r.score.total < threshold) continue;

      const token = pool.baseToken.address;
      const prev = state.alerts[token];
      const cooling = prev && now - prev.at < CONFIG.realertCooldownHours * HOUR;
      if (cooling && r.score.total < prev.score + CONFIG.realertScoreJump) continue;

      const paperOpened = openPosition(state.paper, {
        token, symbol: pool.baseToken.symbol, pool: pool.poolAddress, price: pool.priceUsd, score: r.score.total,
      }, now);
      await notify(alertMessage({ ...r, plan: planFor(pool.priceUsd), regime: reg, warnings: r.filt.warnings, paperOpened }));
      state.alerts[token] = { at: now, score: r.score.total, symbol: pool.baseToken.symbol };
      runStats.alerts += 1;
      if (row) row.decision = 'ALERT';
    }

    // 6. Daily digest
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone }).format(now);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.timezone, hour: 'numeric', hourCycle: 'h23' }).format(now));
    if (state.lastDigest !== today && hour >= CONFIG.digestHourLocal) {
      const alerts24h = Object.values(state.alerts).filter((a) => now - a.at < 24 * HOUR).length;
      await notify(digestMessage({ paper: state.paper, eq: equity(state.paper, prices), stats: stats(state.paper), regime: reg, runStats, alerts24h }));
      state.lastDigest = today;
    }

    state.lastRun = { at: new Date(now).toISOString(), ...runStats, regime: reg.state };
    log(`done: ${runStats.alerts} alert(s)`);
  } finally {
    const month = new Date(now).toISOString().slice(0, 7);
    appendCsv(`snapshots/${month}.csv`, SNAPSHOT_COLUMNS, snapshots);
    saveState(state);
  }
  return runStats;
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
    score: r.score?.total ?? null,
    decision: r.filt.ok ? 'scored' : 'rejected',
    reasons: r.filt.ok ? r.filt.warnings.join('; ') : r.filt.reasons.join('; '),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
