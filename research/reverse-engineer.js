// REVERSE-ENGINEER PAST RUNNERS
//
// Runs daily (and on demand). Answers: "Which Robinhood Chain coins fit our profile
// and then ran 3x+, who bought them before the run, and what did the winners have
// in common that the duds didn't?"
//
//  1. Collect candidate coins (holder-count list, scanner watchlist, research history).
//  2. Walk each coin's daily chart and find SETUPS — days where it matched our rules:
//       ≥21 days old · $10k–$333k market cap · ≥50% off its high · 7-day base ≤1.8× range
//  3. Label each setup: WIN if it hit 3x within 30 days, otherwise DUD.
//  4. Compare winners vs duds on chart traits (drawdown, base tightness, volume, age…).
//  5. With a Blockscout key: pull each setup's buyers from the week BEFORE the setup,
//     clean out bundles/bots, and find wallets that bought early into several winners
//     (and rarely into duds). Those become seeded "smart wallets" for the live scanner.
//  6. Write data/research/report.md + setups.csv + smart-wallets.json, merge the
//     wallets into data/wallets.json, and send a Telegram summary.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG } from '../config.js';
import * as gecko from '../src/gecko.js';
import * as bs from '../src/blockscout.js';
import { loadState, DATA_DIR, appendCsv } from '../src/store.js';
import { loadWallets, saveWallets } from '../src/wallets.js';
import { notify } from '../src/notify.js';

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
  windowDays: 30,
  minGapDays: 30, // one setup per coin per 30 days
  maxWalletSetups: 30, // setups (winners first) whose buyers we pull
  maxTransferPages: 30, // per setup (50 transfers/page)
  preRunDays: 7,
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
    const label = hitIdx >= 0 ? 'WIN' : matured ? 'DUD' : null; // null = still playing out
    if (!label) continue;

    const prev7 = candles.slice(i - 7, i);
    const avgVol = prev7.reduce((s, x) => s + x.v, 0) / prev7.length;
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
    });
  }
  return out;
}

// ── step 5: buyers before the setup ─────────────────────────
// A "buy" = tokens moving from a contract (pool / router / pool manager) to a normal wallet.
export function preRunBuyers(transfers, setupT, preDays = R.preRunDays) {
  const start = setupT - preDays * DAY;
  const end = setupT + DAY;
  const inWin = transfers.filter((x) => x.ts && x.ts >= start && x.ts <= end);
  const buys = inWin.filter(
    (x) => x.fromIsContract && !x.toIsContract && x.to && !bs.BURN_ADDRESSES.has(x.from) && !bs.BURN_ADDRESSES.has(x.to)
  );
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
  const covered = transfers.length && Math.min(...transfers.map((x) => x.ts || Infinity)) <= start;
  return { wallets, bundledCount: bundled.size, rawBuys: buys.length, covered };
}

// Wallet overlap across setups → smart wallets
export function findSmartWallets(analysed) {
  const n = analysed.length;
  const stats = new Map(); // wallet → { win, dud, syms:Set }
  for (const a of analysed) {
    for (const addr of a.buyers.wallets.keys()) {
      const s = stats.get(addr) || { win: 0, dud: 0, syms: new Set() };
      if (a.setup.label === 'WIN') s.win += 1;
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

  // current price + market cap for every coin's pool
  const live = new Map();
  try {
    for (const p of await gecko.poolsMulti(coins.map((c) => c.pool))) live.set(p.poolAddress, p);
  } catch (e) {
    log('pool refresh failed:', e.message);
  }

  // steps 2–3
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
    for (const s of findSetups(candles, { mcapNow: p.marketCap, priceNow: p.priceUsd }, now)) {
      setups.push({ ...c, setup: s });
    }
  }
  const wins = setups.filter((s) => s.setup.label === 'WIN');
  const duds = setups.filter((s) => s.setup.label === 'DUD');
  log(`research: ${setups.length} setups → ${wins.length} winners, ${duds.length} duds`);

  // step 5: wallets (needs Blockscout)
  const analysed = [];
  const walletNotes = [];
  const toAnalyse = [...wins, ...duds.slice(0, Math.max(0, R.maxWalletSetups - wins.length))].slice(0, R.maxWalletSetups);
  for (const s of toAnalyse) {
    try {
      const transfers = await bs.tokenTransfers(s.token, {
        sinceMs: s.setup.t - R.preRunDays * DAY,
        maxPages: R.maxTransferPages,
      });
      const buyers = preRunBuyers(transfers, s.setup.t);
      if (!buyers.covered) {
        walletNotes.push(`$${s.symbol}: too much trading since the setup to reach back that far — skipped`);
        continue;
      }
      analysed.push({ ...s, buyers });
      s.setup.preBuyers = buyers.wallets.size;
      s.setup.bundled = buyers.bundledCount;
    } catch (e) {
      walletNotes.push(`$${s.symbol}: wallet history unavailable (${e.message.slice(0, 60)})`);
      if (/HTTP 40[13]/.test(e.message)) {
        walletNotes.push('Blockscout refused the requests — add the free BLOCKSCOUT_API_KEY secret to enable wallet research.');
        break;
      }
    }
  }
  const smart = findSmartWallets(analysed);
  const smartSet = new Set(smart.map((s) => s.addr));
  for (const a of analysed) a.setup.smartBuyers = [...a.buyers.wallets.keys()].filter((x) => smartSet.has(x)).length;

  // write setups.csv (fresh each run)
  const csvPath = path.join(outDir, 'setups.csv');
  if (fs.existsSync(csvPath)) fs.rmSync(csvPath);
  appendCsv('research/setups.csv',
    ['date', 'symbol', 'token', 'label', 'peakX', 'daysTo3x', 'mcap', 'ageDays', 'drawdownPct', 'baseRange', 'volRatio', 'preBuyers', 'bundled', 'smartBuyers'],
    setups.map((s) => ({
      date: new Date(s.setup.t).toISOString().slice(0, 10), symbol: s.symbol, token: s.token, label: s.setup.label,
      peakX: s.setup.peakX.toFixed(2), daysTo3x: s.setup.daysTo3x, mcap: Math.round(s.setup.mcap),
      ageDays: s.setup.ageDays.toFixed(0), drawdownPct: s.setup.drawdownPct.toFixed(0), baseRange: s.setup.baseRange.toFixed(2),
      volRatio: s.setup.volRatio?.toFixed(2), preBuyers: s.setup.preBuyers, bundled: s.setup.bundled, smartBuyers: s.setup.smartBuyers,
    })));
  fs.writeFileSync(path.join(outDir, 'smart-wallets.json'), JSON.stringify({ at: new Date(now).toISOString(), wallets: smart }, null, 1));

  // seed the live scanner
  const w = loadWallets();
  w.seeded = {};
  for (const s of smart) w.seeded[s.addr] = { wins: s.wins, duds: s.duds, coins: s.coins, at: now };
  saveWallets(w, now);

  // report
  const hitRate = setups.length ? (wins.length / setups.length) * 100 : 0;
  const fx = (d = 1) => (v) => `${v.toFixed(d)}×`;
  const pctF = (v) => `${v.toFixed(0)}%`;
  const usdF = (v) => (v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`);
  const lines = [
    `# Robinhood Chain — what came before the runs`,
    `_Generated ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC from ${coins.length} coins._`,
    '',
    `## The base rate`,
    `${setups.length} times a coin matched our rules (21+ days old, $10k–$333k, 50%+ off its high, tight 7-day base).`,
    `**${wins.length} of them went 3x within 30 days (${hitRate.toFixed(0)}%).** The other ${duds.length} didn't.`,
    `Any signal is only useful if it beats ${hitRate.toFixed(0)}%.`,
    '',
    `## Winners vs duds (middle value of each group)`,
    compareLine('Volume on the setup day vs its 7-day average', wins.map((x) => x.setup), duds.map((x) => x.setup), 'volRatio', fx(1)),
    compareLine('7-day price range (lower = tighter base)', wins.map((x) => x.setup), duds.map((x) => x.setup), 'baseRange', fx(2)),
    compareLine('Drop from all-time high', wins.map((x) => x.setup), duds.map((x) => x.setup), 'drawdownPct', pctF),
    compareLine('Age', wins.map((x) => x.setup), duds.map((x) => x.setup), 'ageDays', (v) => `${v.toFixed(0)} days`),
    compareLine('Market cap', wins.map((x) => x.setup), duds.map((x) => x.setup), 'mcap', usdF),
    analysed.length ? compareLine('Wallets buying in the week before', analysed.filter((a) => a.setup.label === 'WIN').map((x) => x.setup), analysed.filter((a) => a.setup.label === 'DUD').map((x) => x.setup), 'preBuyers', (v) => v.toFixed(0)) : null,
    '',
    `## Winners`,
    ...(wins.length
      ? wins.map((x) => `- **$${x.symbol}** — ${new Date(x.setup.t).toISOString().slice(0, 10)} at ${usdF(x.setup.mcap)}, peaked at ${x.setup.peakX.toFixed(1)}× (3x in ${x.setup.daysTo3x} days)`)
      : ['- None found yet in this sample.']),
    '',
    `## Smart wallets`,
    analysed.length
      ? `Checked the buyers in the week before ${analysed.length} setups (bundled/bot wallets removed).`
      : `Wallet history wasn't available this run.`,
    smart.length
      ? `**${smart.length} wallet(s)** bought early into ${R.smartMinWinnerHits}+ winners and mostly avoided duds. The live scanner now flags any coin they buy.`
      : 'No wallet showed up early in multiple winners yet — needs more winners in the sample, which grows every week.',
    ...smart.slice(0, 15).map((s) => `- \`${s.addr}\` — early in ${s.wins} winner(s) (${s.coins.join(', ')}), ${s.duds} dud(s)`),
    ...(walletNotes.length ? ['', '## Notes', ...walletNotes.slice(0, 12).map((n) => `- ${n}`)] : []),
  ];
  const report = lines.filter((l) => l !== null).join('\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), report + '\n');

  // Telegram summary
  const tg = [
    '🔬 DAILY RESEARCH — what came before the runs',
    '',
    `Looked at ${coins.length} Robinhood Chain coins.`,
    `${setups.length} times a coin matched our rules → ${wins.length} went 3x within 30 days (${hitRate.toFixed(0)}% hit rate). That's the number to beat.`,
  ];
  const vol = [median(wins.map((x) => x.setup.volRatio)), median(duds.map((x) => x.setup.volRatio))];
  if (vol[0] != null && vol[1] != null) tg.push('', `• Volume on the setup day: winners ${vol[0].toFixed(1)}× normal vs duds ${vol[1].toFixed(1)}×`);
  const rng = [median(wins.map((x) => x.setup.baseRange)), median(duds.map((x) => x.setup.baseRange))];
  if (rng[0] != null && rng[1] != null) tg.push(`• Base tightness: winners ${rng[0].toFixed(2)}× vs duds ${rng[1].toFixed(2)}× (lower = tighter)`);
  if (wins.length) tg.push('', `Winners: ${wins.slice(0, 8).map((x) => `$${x.symbol} (${x.setup.peakX.toFixed(1)}×)`).join(', ')}`);
  tg.push('', smart.length
    ? `🧠 Found ${smart.length} smart wallet(s) that bought early into multiple winners. The scanner now watches them.`
    : analysed.length
      ? '🧠 No repeat early buyers across winners yet — the sample grows every day.'
      : '🧠 Wallet history unavailable — add the free BLOCKSCOUT_API_KEY secret to turn this on.');
  tg.push('', 'Full report: data/research/report.md in the repo');
  await notify(tg.join('\n'));
  log('research done');
  return { coins: coins.length, setups: setups.length, wins: wins.length, smart: smart.length, analysed: analysed.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
