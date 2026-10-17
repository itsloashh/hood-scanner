// Offline tests: fake GeckoTerminal + Blockscout responses, run a full scan,
// and check the filters, scoring, alerting and paper trading behave.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hood-test-'));
process.env.DRY_RUN = '1';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

const { CONFIG } = await import('../config.js');
CONFIG.geckoMinIntervalMs = 0;
CONFIG.blockscoutMinIntervalMs = 0;
CONFIG.scan.pagesPerSort = 1;

const DAY = 86_400_000;
const now = Date.now();
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');

// ── Synthetic market ──────────────────────────────────────
// good  : 40d old, $180k, holders spread, crashed −80% and basing  → should ALERT
// young : 10d old                                                 → rejected (age)
// whale : one wallet holds 30%                                    → rejected (concentration)
// big   : $2M mcap                                                → rejected (mcap)
// leader: large cat coin up 30% (rotation source for GOODCAT)
const coins = {
  good: { sym: 'GOODCAT', token: addr(1), pool: addr(101), mcap: 180_000, liq: 30_000, age: 40, buyers: 70, sellers: 45, ch24: 4, vol: 40_000 },
  young: { sym: 'NEWDOG', token: addr(2), pool: addr(102), mcap: 150_000, liq: 20_000, age: 10, buyers: 80, sellers: 50, ch24: 10, vol: 30_000 },
  whale: { sym: 'WHALEINU', token: addr(3), pool: addr(103), mcap: 120_000, liq: 15_000, age: 30, buyers: 40, sellers: 20, ch24: 2, vol: 10_000 },
  big: { sym: 'BIGCAT', token: addr(4), pool: addr(104), mcap: 2_000_000, liq: 300_000, age: 90, buyers: 900, sellers: 700, ch24: 30, vol: 900_000 },
};
const price = 0.00018;
const SMART = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
fs.mkdirSync(path.join(process.env.DATA_DIR, 'research'), { recursive: true });
fs.writeFileSync(path.join(process.env.DATA_DIR, 'research', 'smart-wallets.json'), JSON.stringify({ wallets: [{ addr: SMART, wins: 3, duds: 0, coins: ['OLDCAT'] }] }));

function poolJson(list) {
  return {
    data: list.map((c) => ({
      id: `robinhood_${c.pool}`,
      type: 'pool',
      attributes: {
        address: c.pool, name: `${c.sym} / WETH`, base_token_price_usd: String(c.price ?? price),
        market_cap_usd: String(c.mcap), fdv_usd: String(c.mcap), reserve_in_usd: String(c.liq),
        pool_created_at: new Date(now - c.age * DAY).toISOString(),
        price_change_percentage: { h1: '0', h6: '1', h24: String(c.ch24) },
        transactions: { h24: { buys: c.buyers * 2, sells: c.sellers * 2, buyers: c.buyers, sellers: c.sellers } },
        volume_usd: { h24: String(c.vol) },
      },
      relationships: {
        base_token: { data: { id: `robinhood_${c.token}`, type: 'token' } },
        quote_token: { data: { id: `robinhood_${addr(999)}`, type: 'token' } },
      },
    })),
    included: [
      ...list.map((c) => ({ id: `robinhood_${c.token}`, type: 'token', attributes: { address: c.token, symbol: c.sym, name: c.sym } })),
      { id: `robinhood_${addr(999)}`, type: 'token', attributes: { address: addr(999), symbol: 'WETH', name: 'Wrapped Ether' } },
    ],
  };
}

const supply = 1_000_000_000n * 10n ** 18n;
const holdersFor = (c) => {
  const pct = (p) => (supply * BigInt(Math.round(p * 100))) / 10_000n;
  const items = [
    { address: { hash: c.pool, is_contract: true }, value: pct(40).toString() }, // LP pool — excluded
    { address: { hash: '0x000000000000000000000000000000000000dead', is_contract: false }, value: pct(5).toString() },
  ];
  const whaleTop = c.sym === 'WHALEINU' ? 30 : 3.5;
  items.push({ address: { hash: addr(5000), is_contract: false }, value: pct(whaleTop).toString() });
  for (let i = 1; i < 30; i++) items.push({ address: { hash: addr(5000 + i), is_contract: false }, value: pct(1.2).toString() });
  return { items };
};

// −80% from ATH, then a tight 7-day base with lows holding and today's volume up
const candles = () => {
  const out = [];
  for (let d = 45; d >= 0; d--) {
    let c;
    if (d > 30) c = price * (1 + (45 - d) * 0.35); // run-up to ~5x
    else if (d > 10) c = price * (5 - (30 - d) * 0.21); // bleed down
    else c = price * (1 + ((d % 3) - 1) * 0.06); // base
    out.push([Math.floor((now - d * DAY) / 1000), c, c * 1.05, c * 0.95, c, d === 0 ? 40_000 : 15_000]);
  }
  return { data: { attributes: { ohlcv_list: out.reverse() } } };
};

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const calls = [];
globalThis.fetch = async (url) => {
  url = String(url);
  calls.push(url);
  const all = Object.values(coins);
  const find = (a) => all.find((c) => url.includes(c.token) || url.includes(c.pool));
  if (url.includes('/pools?page=')) return ok(poolJson(all));
  if (url.includes('/pools/multi/')) return ok(poolJson(all.filter((c) => url.includes(c.pool))));
  if (url.includes('/ohlcv/')) return ok(candles());
  if (url.includes('/trades')) {
    const c = find(url);
    const t0 = now - 6 * 3_600_000;
    const data = [];
    for (let i = 0; i < 40; i++) {
      const buy = i % 3 !== 0;
      data.push({ attributes: {
        tx_hash: `0xtx${i}`, block_number: 1000 + i, block_timestamp: new Date(t0 + i * 300_000).toISOString(),
        tx_from_address: addr(9000 + (i % 25)), kind: buy ? 'buy' : 'sell', volume_in_usd: String(buy ? 60 : 30),
        price_to_in_usd: String(price), price_from_in_usd: String(price),
      } });
    }
    if (c?.sym === 'GOODCAT') data.push({ attributes: { tx_hash: '0xsmart', block_number: 2000, block_timestamp: new Date(now - 3_600_000).toISOString(), tx_from_address: SMART, kind: 'buy', volume_in_usd: '250', price_to_in_usd: String(price) } });
    return ok({ data });
  }
  if (url.includes('api.telegram.org') && url.includes('getChatMemberCount')) return ok({ ok: true, result: 1200 });
  if (url.includes('/info')) {
    const c = find(url);
    return ok({ data: { attributes: { holders: { count: 900 }, gt_score: 62, twitter_handle: c.sym.toLowerCase(), telegram_handle: c.sym.toLowerCase() + 'portal', websites: ['https://x.example'], is_honeypot: 'no', developer_holding_percentage: '1.5', developer_address: addr(5001) } } });
  }
  if (url.includes('blockscout') && url.endsWith('/holders')) return ok(holdersFor(find(url)));
  if (url.includes('blockscout')) return ok({ holders_count: '900', total_supply: supply.toString() });
  return { ok: false, status: 404, json: async () => null };
};

// capture alert output
const printed = [];
const origLog = console.log;
console.log = (...a) => { printed.push(a.join(' ')); };

const { main } = await import('../src/index.js');
const { quickFilter } = await import('../src/filters.js');
const { concentration } = await import('../src/blockscout.js');
const paperMod = await import('../src/paper.js');

let failures = 0;
const { resetBreakers } = await import('../src/http.js');
const test = async (name, fn) => {
  resetBreakers();
  try { await fn(); origLog(`✓ ${name}`); } catch (e) { failures++; origLog(`✗ ${name}\n   ${e.message}`); }
};

// ── Unit checks ──────────────────────────────────────────
await test('quick filter enforces Logan parameters (age ≥21d, mcap ≤ $333k)', () => {
  const { parsePools } = { parsePools: null };
  const mk = (c) => ({
    marketCap: c.mcap, liquidityUsd: c.liq, createdAt: new Date(now - c.age * DAY).toISOString(),
    buyers24h: c.buyers, sellers24h: c.sellers, change: { h24: c.ch24 },
  });
  assert.equal(quickFilter(mk(coins.good), now).ok, true);
  assert.match(quickFilter(mk(coins.young), now).reasons.join(), /younger than 21d/);
  assert.match(quickFilter(mk({ ...coins.big, mcap: 26_000_000 }), now).reasons.join(), /mcap over max/);
  assert.equal(quickFilter(mk({ ...coins.good, mcap: 333_000 }), now).lane, 'micro');
  // above $333k = quality lane: needs $100k+ liquidity
  assert.match(quickFilter(mk({ ...coins.good, mcap: 334_000 }), now).reasons.join(), /quality lane: liquidity/);
  const q = quickFilter(mk({ ...coins.good, mcap: 3_600_000, liq: 400_000 }), now);
  assert.equal(q.ok, true);
  assert.equal(q.lane, 'quality');
  assert.match(quickFilter(mk({ ...coins.good, mcap: 4_000 }), now).reasons.join(), /under min/);
  assert.equal(quickFilter(mk({ ...coins.good, mcap: 8_000, liq: 5_000 }), now).ok, true); // DIH-size survivor
});

await test('concentration ignores LP pool + burn, catches a whale wallet', () => {
  const parse = (j) => j.items.map((i) => ({ address: i.address.hash.toLowerCase(), isContract: i.address.is_contract, value: BigInt(i.value) }));
  const good = concentration(parse(holdersFor(coins.good)), supply, { poolAddresses: [coins.good.pool] });
  const whale = concentration(parse(holdersFor(coins.whale)), supply, { poolAddresses: [coins.whale.pool] });
  assert.ok(good.top1Pct < 5, `good top1 ${good.top1Pct}`);
  assert.ok(whale.top1Pct > 25, `whale top1 ${whale.top1Pct}`);
});

// ── Full scan ────────────────────────────────────────────
let stats1;
await test('full scan alerts on the good coin only, with paper buttons (no auto trade)', async () => {
  stats1 = await main();
  const out = printed.join('\n');
  assert.equal(stats1.buy, 1, `buy alerts ${stats1.buy}\n${out.slice(-3000)}`);
  assert.match(out, /BUY ZONE · \$GOODCAT/);
  assert.match(out, /Telegram @goodcatportal — 1,200 members/);
  assert.match(out, /WHO'S BUYING/);
  assert.match(out, /1 proven wallet\(s\) bought/);
  assert.match(out, /Smart money \+4/);
  if (process.env.SHOW_ALERT) origLog(out.slice(out.indexOf('──── ALERT')));
  assert.doesNotMatch(out, /— \$WHALEINU/);
  assert.doesNotMatch(out, /— \$NEWDOG/);
  assert.match(out, /🎯 Target 3–10x = \$540k to \$1\.80M market cap/);
  assert.match(out, /\[buttons\] 📝 Paper buy → pc:0x0+1/);
  const state = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'state.json'), 'utf8'));
  assert.equal(state.paper.positions.length, 0, 'auto paper trading should be off');
  const cand = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'candidates.json'), 'utf8'));
  assert.equal(cand.coins[0].symbol, 'GOODCAT');
  assert.equal(cand.coins[0].tier, 'buy');
});

await test('snapshot logger wrote the research dataset', () => {
  const month = new Date(now).toISOString().slice(0, 7);
  const csv = fs.readFileSync(path.join(process.env.DATA_DIR, 'snapshots', `v2-${month}.csv`), 'utf8');
  const rows = csv.trim().split('\n');
  assert.ok(rows.length >= 4, `rows ${rows.length}`);
  assert.match(csv, /GOODCAT.*BUY-ALERT/);
  assert.match(csv, /WHALEINU.*top wallet too big/);
});

await test('second run does not re-alert the same coin (cooldown)', async () => {
  printed.length = 0;
  const s = await main();
  assert.equal(s.buy + s.watch, 0);
});

await test('WATCH tier fires below the buy bar, with no paper position', async () => {
  fs.rmSync(path.join(process.env.DATA_DIR, 'state.json'));
  const saved = CONFIG.alertScore;
  CONFIG.alertScore = 99;
  printed.length = 0;
  const s = await main();
  CONFIG.alertScore = saved;
  assert.equal(s.watch, 1);
  assert.equal(s.buy, 0);
  assert.match(printed.join('\n'), /👀 WATCH · \$GOODCAT/);
  const state = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'state.json'), 'utf8'));
  assert.equal(state.paper.positions.length, 0);
});

await test('digest shows the funnel and why coins got cut', () => {
  const out = printed.join('\n');
  assert.match(out, /WHY COINS GOT CUT/);
  assert.match(out, /1 — younger than 21d/);
});

await test('X handle reused on another token gets flagged', async () => {
  const { recordXHandle, cleanHandle } = await import('../src/community.js');
  const idx = {};
  assert.equal(recordXHandle(idx, '@SomeCoin', '0xa'), 0);
  assert.equal(recordXHandle(idx, 'https://x.com/somecoin', '0xb'), 1);
  assert.equal(cleanHandle('https://t.me/HoodCats?start=1'), 'hoodcats');
});

// ── Paper trading rules ──────────────────────────────────
await test('paper: 3x sells half, 5x sells a quarter, trailing stop closes runner', () => {
  const p = paperMod.newPaperState();
  const pos = paperMod.openPosition(p, { token: 't', symbol: 'T', pool: 'p', price: 1, score: 70 }, now);
  const e = pos.entryPrice;
  paperMod.updatePositions(p, { t: { price: e * 3.1, liquidityUsd: 1e5 } }, now);
  assert.equal(pos.remaining, 0.5);
  paperMod.updatePositions(p, { t: { price: e * 5.2, liquidityUsd: 1e5 } }, now);
  assert.equal(pos.remaining, 0.25);
  paperMod.updatePositions(p, { t: { price: e * 5.2 * 0.55, liquidityUsd: 1e5 } }, now);
  assert.equal(p.positions.length, 0);
  assert.ok(p.closed[0].multiple > 2.5, `multiple ${p.closed[0].multiple}`);
});

await test('paper: stop loss at −50% and rug detection', () => {
  const p = paperMod.newPaperState();
  const a = paperMod.openPosition(p, { token: 'a', symbol: 'A', pool: 'pa', price: 1, score: 70 }, now);
  const b = paperMod.openPosition(p, { token: 'b', symbol: 'B', pool: 'pb', price: 1, score: 70 }, now);
  paperMod.updatePositions(p, { a: { price: a.entryPrice * 0.49, liquidityUsd: 1e5 }, b: { price: 1, liquidityUsd: 100 } }, now);
  assert.equal(p.positions.length, 0);
  assert.ok(p.closed.every((t) => t.pnl < 0));
  assert.ok(p.cash < 30 && p.cash > 10, `cash ${p.cash}`);
});

await test('holder backup: GeckoTerminal split used when Blockscout holders fail', async () => {
  const bsMod = await import('../src/blockscout.js');
  const est = bsMod.estimateConcentration({ top10PctRaw: 55 }, { marketCap: 100_000, liquidityUsd: 40_000 });
  assert.equal(est.source, 'estimate');
  assert.ok(Math.abs(est.top10Pct - 35) < 0.01, `top10 ${est.top10Pct}`); // 55% − ~20% pool share
  assert.equal(est.top1Pct, null);
  const { deepFilter } = await import('../src/filters.js');
  const r = deepFilter({ info: { twitter: 'x', devPct: 1 }, holdersCount: 500, conc: est, community: { flags: [] } });
  assert.equal(r.ok, true, r.reasons.join());
  assert.match(r.warnings.join(), /estimated/);
});

await test('discovery finds quiet established coins; stock tokens excluded', async () => {
  fs.rmSync(path.join(process.env.DATA_DIR, 'state.json'));
  const quiet = { sym: 'QUIETFROG', token: addr(7), pool: addr(107), mcap: 90_000, liq: 12_000, age: 50, buyers: 20, sellers: 12, ch24: 1, vol: 3_000 };
  const stock = { sym: 'TSLA', name: 'Tesla Stock Token', token: addr(8), pool: addr(108), mcap: 200_000, liq: 50_000, age: 90, buyers: 50, sellers: 40, ch24: 0, vol: 20_000 };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('blockscout') && url.includes('/tokens?')) {
      return ok({ items: [
        { address_hash: quiet.token, symbol: quiet.sym, name: 'Quiet Frog', holders_count: '640' },
        { address_hash: stock.token, symbol: 'TSLA', name: 'Tesla Stock Token', holders_count: '9000' },
      ], next_page_params: null });
    }
    if (url.includes('/tokens/multi/')) {
      return ok({ data: [{ attributes: { address: quiet.token }, relationships: { top_pools: { data: [{ id: `robinhood_${quiet.pool}` }] } } }] });
    }
    if (url.includes('/pools/multi/') && url.includes(quiet.pool)) return ok(poolJson([quiet]));
    return prevFetch(url);
  };
  printed.length = 0;
  await main();
  globalThis.fetch = prevFetch;
  const state = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'state.json'), 'utf8'));
  assert.ok(state.universe[quiet.token], 'quiet coin not in universe');
  assert.ok(!state.universe[stock.token], 'stock token leaked into universe');
  assert.ok(state.lastRun.holderData, 'health report missing');
  assert.match(printed.join('\n'), /QUIETFROG/);
});

await test('wallet tracker: buys resolve to wins at 3x and losses at −60%', async () => {
  const wm = await import('../src/wallets.js');
  const w = { wallets: {}, tokens: {}, seeded: {} };
  const T = (wallet, tk, p, ts) => ({ wallet, kind: 'buy', priceUsd: p, usd: 50, ts, block: ts });
  wm.ingestTrades(w, 'tkA', 'A', [T('0xw1', 'tkA', 1, now - 1000)], now);
  wm.ingestTrades(w, 'tkB', 'B', [T('0xw1', 'tkB', 1, now - 900)], now);
  wm.ingestTrades(w, 'tkC', 'C', [T('0xw1', 'tkC', 1, now - 800)], now);
  wm.resolveOutcomes(w, { tkA: 3.2, tkB: 3.5, tkC: 0.35 }, now);
  const v = w.wallets['0xw1'];
  assert.equal(v.wins, 2);
  assert.equal(v.losses, 1);
  assert.equal(wm.isSmart(v), true);
});

await test('wallet tracker: spray bots are never "smart"', async () => {
  const wm = await import('../src/wallets.js');
  const w = { wallets: {}, tokens: {}, seeded: {} };
  for (let i = 0; i < 20; i++) wm.ingestTrades(w, `tk${i}`, `S${i}`, [{ wallet: '0xbot', kind: 'buy', priceUsd: 1, usd: 5, ts: now - 100 + i, block: i }], now);
  w.wallets['0xbot'].wins = 5;
  assert.equal(w.wallets['0xbot'].bot, true);
  assert.equal(wm.isSmart(w.wallets['0xbot']), false);
});

await test('flow features: bundles, repeat buyers, net flow', async () => {
  const wm = await import('../src/wallets.js');
  const tr = [
    { wallet: '0xa', kind: 'buy', usd: 100, ts: 1, block: 5 },
    { wallet: '0xb', kind: 'buy', usd: 100, ts: 1, block: 5 },
    { wallet: '0xc', kind: 'buy', usd: 100, ts: 1, block: 5 },
    { wallet: '0xd', kind: 'buy', usd: 700, ts: 2, block: 6 },
    { wallet: '0xd', kind: 'buy', usd: 50, ts: 3, block: 7 },
    { wallet: '0xe', kind: 'sell', usd: 200, ts: 4, block: 8 },
  ];
  const f = wm.flowFeatures(tr, { wallets: {}, seeded: {} });
  assert.equal(f.uniqueBuyers, 4);
  assert.equal(f.repeatBuyers, 1);
  assert.equal(f.netFlowUsd, 850);
  assert.equal(f.whaleBuys, 1);
  assert.ok(Math.abs(f.bundledShare - 0.6) < 1e-9);
});

await test('research: finds setups and labels 3x winners vs duds', async () => {
  const { findSetups } = await import('../research/reverse-engineer.js');
  const D = 86_400_000;
  const t0 = now - 120 * D;
  const mk = (i, c, v = 1000) => ({ t: t0 + i * D, o: c, h: c * 1.02, l: c * 0.98, c, v });
  const cs = [];
  for (let i = 0; i < 20; i++) cs.push(mk(i, 1 + i * 0.2)); // pump to ~4.8
  for (let i = 20; i < 35; i++) cs.push(mk(i, 4.8 - (i - 20) * 0.28)); // bleed to ~0.9
  for (let i = 35; i < 45; i++) cs.push(mk(i, 0.9 + (i % 2) * 0.05)); // base
  for (let i = 45; i < 60; i++) cs.push(mk(i, 0.9 * (1 + (i - 44) * 0.25), 4000)); // run to ~4.5x
  for (let i = 60; i < 120; i++) cs.push(mk(i, 2));
  const setups = findSetups(cs, { mcapNow: 200_000, priceNow: 2 }, now);
  assert.ok(setups.length >= 1, 'no setups');
  assert.equal(setups[0].label, 'WIN');
  assert.ok(setups[0].peakX >= 3);
  assert.ok(setups.every((s) => s.mcap <= 333_000));
});

await test('research: pre-run buyers drop bundles; overlap finds smart wallets, not bots', async () => {
  const { preRunBuyers, findSmartWallets } = await import('../research/reverse-engineer.js');
  const D = 86_400_000;
  const T = now - 40 * D;
  const tx = (to, ts, block, fromC = true) => ({ to, from: '0xpool', fromIsContract: fromC, toIsContract: false, ts, block, value: '1000000000000000000', decimals: 18 });
  const mkBuyers = (list) => preRunBuyers([...list, tx('0xold', T - 9 * D, 1)], T);
  const b1 = mkBuyers([tx('0xsmart', T - 2 * D, 10), tx('0xb1', T - D, 11), tx('0xb2', T - D, 11), tx('0xb3', T - D, 11), tx('0xbot', T - D, 12)]);
  assert.ok(b1.covered);
  assert.ok(!b1.wallets.has('0xb1'), 'bundle wallet kept');
  assert.ok(b1.wallets.has('0xsmart'));
  const b2 = mkBuyers([tx('0xsmart', T - 3 * D, 20), tx('0xbot', T - D, 21)]);
  const b3 = mkBuyers([tx('0xbot', T - D, 30)]);
  const b4 = mkBuyers([tx('0xbot', T - D, 40), tx('0xrand', T - D, 41)]);
  const smart = findSmartWallets([
    { symbol: 'W1', setup: { label: 'WIN' }, buyers: b1 },
    { symbol: 'W2', setup: { label: 'WIN' }, buyers: b2 },
    { symbol: 'D1', setup: { label: 'DUD' }, buyers: b3 },
    { symbol: 'D2', setup: { label: 'DUD' }, buyers: b4 },
  ]);
  assert.deepEqual(smart.map((s) => s.addr), ['0xsmart']);
});

await test('slow API: a host that keeps failing is skipped for the rest of the run', async () => {
  const { getJson } = await import('../src/http.js');
  const prevFetch = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => { hits++; return new Response('timeout', { status: 524 }); };
  try {
    for (let i = 0; i < 3; i++) await getJson('https://slow.example/x', { retries: 3 }).catch(() => null);
    const before = hits;
    await assert.rejects(getJson('https://slow.example/y'), /skipped for the rest of this run/);
    assert.equal(hits, before); // no more calls once the breaker trips
    assert.ok(hits <= 4, `hits ${hits}`); // 524s retry at most once each
  } finally {
    globalThis.fetch = prevFetch;
  }
});

await test('rate limits: a 429 slows that host down instead of hammering it', async () => {
  const { getJson, httpStats } = await import('../src/http.js');
  const prevFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => (++n % 2 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : new Response('{"ok":1}'));
  try {
    const t0 = Date.now();
    assert.deepEqual(await getJson('https://busy.example/a', { minIntervalMs: 0 }), { ok: 1 });
    assert.equal(httpStats['busy.example'].r429, 1);
    // next call waits for the slowed pace (≥3s after a 429), not hammering immediately
    await getJson('https://busy.example/b', { minIntervalMs: 0 }).catch(() => null);
    assert.ok(Date.now() - t0 >= 2900, `only ${Date.now() - t0}ms`);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

await test('holders job: slow Blockscout lists saved for the scan; buy zone needs the top wallet checked', async () => {
  const hj = await import('../src/holders-job.js');
  const holders = { coins: { '0xold': { at: Date.now(), conc: {} } } };
  const t = hj.pickTargets({ watchlist: { '0xw': { pool: '0xwp', symbol: 'W' }, '0xold': { pool: '0xop', symbol: 'O' } } },
    [{ token: '0xs', pool: '0xsp', symbol: 'S', tier: 'scored' }, { token: '0xb', pool: '0xbp', symbol: 'B', tier: 'buy' }], holders);
  assert.deepEqual(t.map((x) => x.token), ['0xb', '0xs', '0xw']); // buy first, fresh ones skipped
  const { scoreCoin } = await import('../src/score.js');
  const pool = { baseToken: { symbol: 'X' }, marketCap: 100_000, liquidityUsd: 20_000, volume24h: 5000, buyers24h: 50, sellers24h: 30, change: { h24: 2 } };
  const est = scoreCoin({ pool, holdersCount: 900, conc: { top10Pct: 20, top1Pct: null, source: 'estimate' }, socials: 2, chart: null, rotation: {}, community: {} });
  assert.equal(est.buyBlocked, true);
  assert.match(est.buyBlockedWhy, /biggest single wallet/);
  const real = scoreCoin({ pool, holdersCount: 900, conc: { top10Pct: 20, top1Pct: 3 }, socials: 2, chart: null, rotation: {}, community: {} });
  assert.equal(real.buyBlocked, false);
});

await test('scorecard: every alert is followed to 3x, −50% or 30 days', async () => {
  const sc = await import('../src/scorecard.js');
  const card = [];
  const t0 = Date.now();
  assert.equal(sc.recordAlert(card, { token: 'a', symbol: 'A', tier: 'buy', lane: 'quality', price: 1 }, t0), true);
  assert.equal(sc.recordAlert(card, { token: 'a', symbol: 'A', tier: 'buy', price: 1.1 }, t0), false); // no duplicates while open
  sc.recordAlert(card, { token: 'b', symbol: 'B', tier: 'watch', lane: 'micro', price: 1 }, t0);
  sc.recordAlert(card, { token: 'c', symbol: 'C', tier: 'watch', lane: 'micro', price: 1 }, t0);
  sc.updateScorecard(card, { a: 2.2, b: 0.7, c: 1.2 }, t0 + 3_600_000);
  sc.updateScorecard(card, { a: 3.1, b: 0.45, c: 1.1 }, t0 + 7_200_000);
  assert.equal(card[0].outcome, 'win');
  assert.equal(card[1].outcome, 'stopped');
  assert.equal(card[2].outcome, null);
  sc.updateScorecard(card, {}, t0 + 31 * 86_400_000);
  assert.equal(card[2].outcome, 'expired');
  const sum = sc.summarize(card);
  assert.equal(sum['buy/quality'].win, 1);
  assert.equal(sum['watch/micro'].stopped, 1);
  assert.equal(sum['watch/micro'].winRate, 0);
  const { digestMessage } = await import('../src/messages.js');
  const msg = digestMessage({ paper: { positions: [] }, eq: 30, stats: {}, regime: { state: 'neutral' }, funnel: { runs: 1, scanned: 1, quickPass: 1, deepPass: 1, reasons: {} }, buy24h: 0, watch24h: 0, scorecard: sum });
  assert.match(msg, /ALERT SCORECARD/);
  assert.match(msg, /🟢 Buy \(quality\): 1 alert/);
});

await test('API keys never appear in error messages (public logs)', async () => {
  const { redact } = await import('../src/http.js');
  assert.equal(redact('HTTP 403 for https://api.blockscout.com/4663/api/v2/tokens?x=1&apikey=proapi_SECRET123'), 'HTTP 403 for https://api.blockscout.com/4663/api/v2/tokens?x=1&apikey=***');
  process.env.BLOCKSCOUT_API_KEY = 'proapi_TEST';
  const bsm = await import('../src/blockscout.js');
  assert.equal(bsm.bsUrl('/tokens/0xabc'), 'https://api.blockscout.com/4663/api/v2/tokens/0xabc?apikey=proapi_TEST');
  delete process.env.BLOCKSCOUT_API_KEY;
  assert.equal(bsm.bsUrl('/tokens/0xabc'), 'https://robinhoodchain.blockscout.com/api/v2/tokens/0xabc');
});

await test('research job runs end-to-end and writes a report', async () => {
  const { main: research } = await import('../research/reverse-engineer.js');
  printed.length = 0;
  const r = await research();
  assert.ok(r.coins >= 1, 'no coins');
  const report = fs.readFileSync(path.join(process.env.DATA_DIR, 'research', 'report.md'), 'utf8');
  assert.match(report, /The base rate/);
  assert.match(printed.join('\n'), /DAILY RESEARCH/);
});

await test('wash trading: ROO-style churn is flagged and blocked from the buy zone', async () => {
  const wm = await import('../src/wallets.js');
  const { scoreCoin } = await import('../src/score.js');
  // 37 wallets, each buying and selling repeatedly in small sizes (ROO, 17 Oct)
  const tr = [];
  for (let i = 0; i < 300; i++) tr.push({ wallet: `0xw${i % 37}`, kind: i % 2 ? 'buy' : 'sell', usd: 6 + (i % 18), ts: i * 36_000, block: i });
  const f = wm.flowFeatures(tr, { wallets: {}, seeded: {} });
  assert.equal(f.washLikely, true, JSON.stringify(f));
  const pool = { marketCap: 102_000, liquidityUsd: 23_000, volume24h: 2_000, buyers24h: 116, sellers24h: 116, change: { h24: 8 } };
  const sc = scoreCoin({ pool, holdersCount: 24_206, conc: { top10Pct: 15.5, top1Pct: 1.7 }, socials: 2, chart: null, holderChangePct: null, rotation: {}, stockPaired: false, community: {}, flow: f });
  assert.equal(sc.buyBlocked, true);
  assert.equal(sc.parts.washPenalty, -15);
  assert.equal(sc.parts.inflatedHoldersPenalty, -6);
  // ROO on its second look (17 Oct, 16:44): 47 buyers / 40 sellers, 50% on both sides, 5.2 trades each
  const roo2 = [];
  for (let i = 0; i < 300; i++) {
    const k = i % 57; // 57 wallets in total
    const both = k < 30; // 30 trade both sides
    const kind = both ? (i % 2 ? 'buy' : 'sell') : k < 47 ? 'buy' : 'sell';
    roo2.push({ wallet: `0xr${k}`, kind, usd: 13, ts: i * 36_000, block: i });
  }
  const f2 = wm.flowFeatures(roo2, { wallets: {}, seeded: {} });
  assert.ok(f2.overlap >= 0.45 && f2.overlap < 0.6, `overlap ${f2.overlap}`);
  assert.equal(f2.washLikely, true, JSON.stringify(f2.washSignals));
  // organic flow: many different wallets, few on both sides
  const org = [];
  for (let i = 0; i < 120; i++) org.push({ wallet: `0xo${i}`, kind: i % 4 ? 'buy' : 'sell', usd: 40, ts: i * 60_000, block: 1000 + i });
  assert.equal(wm.flowFeatures(org, { wallets: {}, seeded: {} }).washLikely, false);
});

await test('/check: full report for any coin, listing which rules it fails', async () => {
  const { checkCoin } = await import('../src/index.js');
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('/tokens/multi/')) {
      const c = Object.values(coins).find((x) => url.includes(x.token));
      return ok({ data: c ? [{ attributes: { address: c.token }, relationships: { top_pools: { data: [{ id: `robinhood_${c.pool}` }] } } }] : [] });
    }
    return prevFetch(url);
  };
  const stateBefore = fs.readFileSync(path.join(process.env.DATA_DIR, 'state.json'), 'utf8');

  printed.length = 0;
  const good = await checkCoin(coins.good.token);
  assert.equal(good.failed.length, 0, good.failed.join());
  assert.match(printed.join('\n'), /🔍 CHECK · \$GOODCAT/);
  assert.match(printed.join('\n'), /No paper trade opened/);

  printed.length = 0;
  const whale = await checkCoin(coins.whale.token);
  assert.ok(whale.failed.includes('top wallet too big'), whale.failed.join());
  assert.match(printed.join('\n'), /Would NOT alert — fails/);
  assert.match(printed.join('\n'), /❌ top wallet too big/);

  printed.length = 0;
  assert.equal(await checkCoin('not-an-address'), null);
  assert.match(printed.join('\n'), /isn't a valid contract address/);

  globalThis.fetch = prevFetch;
  assert.equal(fs.readFileSync(path.join(process.env.DATA_DIR, 'state.json'), 'utf8'), stateBefore, 'check mode must not change state');
});

await test('telegram relay: commands trigger GitHub, strangers and forged requests are ignored', async () => {
  const worker = (await import('../worker/worker.js')).default;
  const env = { TELEGRAM_BOT_TOKEN: 'T', ALLOWED_CHAT_ID: '111', GITHUB_TOKEN: 'G', WEBHOOK_SECRET: 'sec_123', GITHUB_REPO: 'itsloashh/hood-scanner' };
  const sent = [];
  const dispatched = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('api.telegram.org')) {
      sent.push({ method: url.split('/').pop(), body: JSON.parse(init.body || '{}') });
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes('/dispatches')) {
      dispatched.push({ wf: url.split('/workflows/')[1].split('/')[0], body: JSON.parse(init.body), auth: init.headers.authorization });
      return new Response(null, { status: 204 });
    }
    if (url.includes('raw.githubusercontent.com')) {
      return new Response(JSON.stringify({ lastRun: { at: new Date().toISOString(), scanned: 190, quickPass: 3, deepPass: 2, buy: 1, watch: 1, regime: 'neutral', wallets: { tracked: 212, smart: 0 } }, paper: { cash: 20, positions: [{ symbol: 'ROO', entryPrice: 1, lastPrice: 1.1, sizeUsd: 10 }], closed: [] } }));
    }
    return new Response('nope', { status: 404 });
  };
  const post = (text, chat = 111, secret = 'sec_123') => worker.fetch(new Request('https://bot.example.workers.dev/telegram', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ message: { chat: { id: chat }, text } }),
  }), env);

  await post('/scan');
  assert.equal(dispatched.at(-1).wf, 'scan.yml');
  assert.deepEqual(dispatched.at(-1).body, { ref: 'main', inputs: {} });
  assert.equal(dispatched.at(-1).auth, 'Bearer G');
  assert.match(sent.at(-1).body.text, /Scan started/);

  const CA = '0x3458E003f6ed93df0f537b8acac6fbe08e41247f';
  await post(`/check ${CA}`);
  assert.deepEqual(dispatched.at(-1).body.inputs, { ca: CA.toLowerCase() });
  await post(CA); // pasted address
  assert.equal(dispatched.length, 3);
  await post('/check nonsense');
  assert.equal(dispatched.length, 3);
  assert.match(sent.at(-1).body.text, /Send it like this/);

  await post('/research');
  assert.equal(dispatched.at(-1).wf, 'research.yml');

  await post('/status');
  assert.match(sent.at(-1).body.text, /190 coins → 3 survived/);

  const before = { d: dispatched.length, s: sent.length };
  await post('/scan', 999); // stranger
  const forged = await post('/scan', 111, 'wrong');
  assert.equal(forged.status, 403);
  assert.equal(dispatched.length, before.d);
  assert.equal(sent.length, before.s);

  const bad = await worker.fetch(new Request('https://bot.example.workers.dev/setup?key=wrong'), env);
  assert.equal(bad.status, 403);
  const good = await worker.fetch(new Request('https://bot.example.workers.dev/setup?key=sec_123'), env);
  assert.equal(good.status, 200);
  const hook = sent.find((x) => x.method === 'setWebhook');
  assert.equal(hook.body.url, 'https://bot.example.workers.dev/telegram');
  assert.equal(hook.body.secret_token, 'sec_123');
  // cron clock: every 15 min → scan, daily → research
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  await worker.scheduled({ cron: '*/15 * * * *' }, env, ctx);
  await worker.scheduled({ cron: '23 14 * * *' }, env, ctx);
  await Promise.all(waits);
  assert.deepEqual(dispatched.slice(-2).map((d) => d.wf), ['scan.yml', 'research.yml']);
  globalThis.fetch = prevFetch;
});

await test('GitHub backup schedule skips when a scan just ran; manual runs never skip', async () => {
  const st = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'state.json'), 'utf8'));
  st.lastRun = { ...(st.lastRun || {}), at: new Date().toISOString() };
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'state.json'), JSON.stringify(st));
  process.env.GITHUB_EVENT_NAME = 'schedule';
  const r = await main();
  assert.equal(r.skipped, true);
  process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
  const r2 = await main();
  assert.ok(!r2.skipped);
  delete process.env.GITHUB_EVENT_NAME;
});

await test('research: >10x runs are MOON (not learned from); 3–10x are WIN', async () => {
  const { findSetups } = await import('../research/reverse-engineer.js');
  const D = 86_400_000;
  const t0 = now - 120 * D;
  const mk = (i, c, v = 1000) => ({ t: t0 + i * D, o: c, h: c * 1.02, l: c * 0.98, c, v });
  const cs = [];
  for (let i = 0; i < 20; i++) cs.push(mk(i, 1 + i * 0.2));
  for (let i = 20; i < 35; i++) cs.push(mk(i, 4.8 - (i - 20) * 0.28));
  for (let i = 35; i < 45; i++) cs.push(mk(i, 0.9 + (i % 2) * 0.05));
  for (let i = 45; i < 60; i++) cs.push(mk(i, 0.9 * (1 + (i - 44) * 1.2), 9000)); // to ~17x
  for (let i = 60; i < 120; i++) cs.push(mk(i, 10));
  const s = findSetups(cs, { mcapNow: 2_000_000, priceNow: 10 }, now);
  assert.equal(s[0].label, 'MOON');
  assert.ok(s[0].runVolX >= 3, 'volume ignition not measured');
});

await test('research: transfers → real buyers, buyer surge, burns, wash detection', async () => {
  const { analyzeTransfers, isViable } = await import('../research/reverse-engineer.js');
  const D = 86_400_000;
  const T = now - 40 * D;
  const ONE = '1000000000000000000';
  const buy = (to, ts, block) => ({ to, from: '0xpool', fromIsContract: true, toIsContract: false, ts, block, value: ONE, decimals: 18 });
  const sell = (from, ts, block) => ({ from, to: '0xpool', fromIsContract: false, toIsContract: true, ts, block, value: ONE, decimals: 18 });
  const burn = (ts, block) => ({ from: '0xdev', to: '0x000000000000000000000000000000000000dead', fromIsContract: false, toIsContract: false, ts, block, value: ONE, decimals: 18 });
  const tx = [buy('0xancient', T - 20 * D, 1)];
  for (let i = 0; i < 10; i++) tx.push(buy(`0xp${i}`, T - 10 * D, 100 + i)); // week before: 10 buyers
  for (let i = 0; i < 20; i++) tx.push(buy(`0xb${i}`, T - 3 * D, 200 + i)); // pre-week: 20 buyers
  tx.push(burn(T - 2 * D, 300), burn(T + 5 * D, 400), burn(T + 6 * D, 401));
  const a = analyzeTransfers(tx, T);
  assert.equal(a.realBuyers, 20);
  assert.equal(a.prevBuyers, 10);
  assert.equal(Math.round(a.buyerGrowthPct), 100);
  assert.equal(a.burnsPre, 1);
  assert.equal(a.burnsDuring, 2);
  assert.equal(a.washLikely, false);
  assert.equal(isViable(a), true);
  // same 6 wallets churning both sides → wash
  const wash = [buy('0xancient', T - 20 * D, 1)];
  for (let i = 0; i < 60; i++) { const k = Math.floor(i / 2) % 6; wash.push(i % 2 ? buy(`0xw${k}`, T - 2 * D + i, 500 + i) : sell(`0xw${k}`, T - 2 * D + i, 500 + i)); }
  const w = analyzeTransfers(wash, T);
  assert.equal(w.washLikely, true);
  assert.equal(isViable(w), false);
});

await test('research: catalysts and lift rank what shows up before winners', async () => {
  const { catalysts, catalystLift } = await import('../research/reverse-engineer.js');
  const mkS = (label, surge, burns) => ({ setup: { label, volRatio: 1, runVolX: label === 'WIN' ? 5 : 1 }, catalysts: catalysts({ volRatio: 1, runVolX: label === 'WIN' ? 5 : 1 }, { buyerGrowthPct: surge, burnsPre: burns, burnsDuring: 0 }, {}) });
  const wins = [mkS('WIN', 80, 1), mkS('WIN', 120, 0), mkS('WIN', 10, 1)];
  const duds = [mkS('DUD', 5, 0), mkS('DUD', 70, 0), mkS('DUD', 0, 0), mkS('DUD', 0, 0)];
  const lift = catalystLift(wins, duds);
  const surge = lift.find((r) => r.key === 'buyerSurge');
  assert.equal(surge.winners, 2);
  assert.equal(surge.duds, 1);
  assert.ok(Math.abs(surge.lift - (2 / 3) / (1 / 4)) < 1e-9);
  assert.equal(lift.find((r) => r.key === 'burnsBefore').lift, Infinity);
  assert.equal(lift.find((r) => r.key === 'volumeIgnition').when, 'during');
});

await test('burns: recent burns counted per token; supply burned adds a bonus', async () => {
  const bsm = await import('../src/blockscout.js');
  const { scoreCoin } = await import('../src/score.js');
  const prevFetch = globalThis.fetch;
  const TK = '0x00000000000000000000000000000000000000aa';
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('/token-transfers')) {
      const recent = new Date(now - 2 * 86_400_000).toISOString();
      const old = new Date(now - 30 * 86_400_000).toISOString();
      return ok({ items: [
        { timestamp: recent, token: { address_hash: TK }, from: { hash: '0xholder' }, total: { value: '5000000000000000000', decimals: '18' } },
        { timestamp: old, token: { address_hash: TK }, from: { hash: '0xholder' }, total: { value: '1', decimals: '18' } },
        { timestamp: recent, token: { address_hash: '0xother' }, from: { hash: '0xholder' }, total: { value: '1', decimals: '18' } },
      ] });
    }
    return prevFetch(url);
  };
  const r = await bsm.recentBurns(TK, now - 7 * 86_400_000);
  globalThis.fetch = prevFetch;
  assert.equal(r.count, 2); // one recent burn found at each of the two burn addresses (same mock)
  assert.ok(r.units >= 5);
  const pool = { marketCap: 100_000, liquidityUsd: 20_000, volume24h: 5_000, buyers24h: 40, sellers24h: 20, change: { h24: 2 } };
  const base = { pool, holdersCount: 800, conc: { top10Pct: 20, top1Pct: 3 }, socials: 2, chart: null, holderChangePct: null, rotation: {}, stockPaired: false, community: {} };
  assert.equal(scoreCoin({ ...base, burns: { burnedPct: 55, recent: r } }).parts.burn, 5);
  assert.equal(scoreCoin({ ...base, burns: { burnedPct: 5, recent: { count: 0 } } }).parts.burn, 0);
});

await test('pullback stats: pump events measured and bucketed', async () => {
  const { pumpEvents, pullbackStats } = await import('../research/reverse-engineer.js');
  const D = 86_400_000;
  const mk = (i, c, h = c * 1.02, l = c * 0.98) => ({ t: i * D, o: c, h, l, c, v: 1000 });
  const evs = [];
  for (let k = 0; k < 6; k++) {
    // flat at 1 → +80% day (peak 1.9) → pulls back to 1.4 → new high 2.0 a week later
    const cs = [mk(0, 1), mk(1, 1), mk(2, 1.8, 1.9), mk(3, 1.6), mk(4, 1.45, 1.5, 1.4), mk(5, 1.5), mk(6, 1.6), mk(7, 1.7), mk(8, 1.8), mk(9, 1.9), mk(10, 2, 2.05), mk(11, 2), mk(12, 2)];
    evs.push(...pumpEvents(cs));
  }
  assert.equal(evs.length, 6);
  assert.ok(Math.abs(evs[0].retrace - (1.9 - 1.4) / 0.9) < 1e-9);
  const st = pullbackStats(evs);
  assert.equal(st['50-100'].n, 6);
  assert.equal(st['50-100'].pPullback30, 0); // 1.9 → 1.4 is a 26% drop
  assert.equal(st['50-100'].pNewHigh14, 1);
  assert.equal(st['100-200'].n, 0);
});

await test('pump path: coin up 120% gets pullback odds + limit-buy entry, judged on pre-pump size', async () => {
  const { pumpPlan } = await import('../src/pump.js');
  const pool = { priceUsd: 2.2, marketCap: 440_000, liquidityUsd: 60_000, change: { h24: 120 } };
  const candles = [{ h: 2.5 }, { h: 2.4 }];
  const stats = { buckets: { '100-200': { n: 12, pPullback30: 0.75, retraceP25: 0.3, retraceMedian: 0.5, retraceP75: 0.7, pNewHigh14: 0.25, pFullRetrace: 0.1, medianDaysToLow: 3 } } };
  const plan = pumpPlan({ pool, candles, stats });
  assert.equal(plan.key, '100-200');
  assert.equal(plan.proven, true);
  assert.ok(Math.abs(plan.base - 1) < 1e-9);
  assert.ok(Math.abs(plan.entryMid - 1.75) < 1e-9); // peak 2.5 − 50% of the 1.5 move
  assert.ok(plan.stop < 1 && plan.stop > 0.95);
  assert.equal(plan.status, 'above');
  const generic = pumpPlan({ pool, candles, stats: null });
  assert.equal(generic.proven, false);
  // real chain stats (17 Oct): +100–200% pumps gave back 77–114% of the move
  const real = pumpPlan({ pool, candles, stats: { buckets: { '100-200': { n: 7, pPullback30: 0.86, retraceP25: 0.77, retraceMedian: 1.1, retraceP75: 1.14, pNewHigh14: 0.14, pFullRetrace: 0.71, medianDaysToLow: 5 } } } });
  assert.equal(real.roundTrip, true);
  assert.ok(real.stop < real.entryDeep, `stop ${real.stop} must sit below deepest entry ${real.entryDeep}`);

  const { pumpFilter } = await import('../src/filters.js');
  const f = pumpFilter({ marketCap: 440_000, liquidityUsd: 60_000, createdAt: new Date(now - 40 * 86_400_000).toISOString(), buyers24h: 90, sellers24h: 60, change: { h24: 120 } }, now);
  assert.equal(f.ok, true, f.reasons.join()); // $440k now, but $200k before the pump → fits the $333k rule
  assert.ok(Math.abs(f.baseMcap - 200_000) < 1);
});

await test('pump path end-to-end: alert with limit-buy button', async () => {
  fs.rmSync(path.join(process.env.DATA_DIR, 'state.json'));
  const saved = { ...coins.good };
  coins.good.ch24 = 120; coins.good.mcap = 396_000; // was $180k before the pump
  printed.length = 0;
  const r = await main();
  Object.assign(coins.good, saved);
  const out = printed.join('\n');
  assert.equal(r.pump, 1, out.slice(-2500));
  assert.match(out, /🚀 PUMPING · \$GOODCAT/);
  assert.match(out, /Best limit buy:/);
  assert.match(out, /Paper limit buy @ .* → pl:0x0+1/);
  const cand = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'candidates.json'), 'utf8'));
  assert.ok(cand.coins.find((c) => c.tier === 'pump' && c.entry?.mid > 0));
});

await test('paper menu: buttons place trades, TP/SL fire on the cron, limits fill, P/L adds up', async () => {
  const W = await import('../worker/worker.js');
  const worker = W.default;
  const kv = new Map();
  const PAPER = { get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => kv.set(k, v) };
  const env = { TELEGRAM_BOT_TOKEN: 'T', ALLOWED_CHAT_ID: '111', GITHUB_TOKEN: 'G', WEBHOOK_SECRET: 's', GITHUB_REPO: 'itsloashh/hood-scanner', PAPER };
  const TK = '0x00000000000000000000000000000000000000c1';
  const PL = '0x00000000000000000000000000000000000000p1'.replace('p', 'a');
  let px = 1;
  const sent = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('api.telegram.org')) { sent.push({ m: url.split('/').pop(), b: JSON.parse(init.body || '{}') }); return new Response(JSON.stringify({ ok: true })); }
    if (url.includes('raw.githubusercontent.com') && url.includes('candidates.json')) {
      return new Response(JSON.stringify({ coins: [
        { token: TK, symbol: 'CATX', pool: PL, tier: 'buy', score: 71, mcap: 150000, price: 1 },
        { token: '0xpump', symbol: 'PUMPY', pool: '0xpp', tier: 'pump', score: 60, mcap: 400000, entry: { top: 0.9, mid: 0.8, deep: 0.7, stop: 0.6 } },
        { token: '0xwash', symbol: 'WASH', pool: '0xww', tier: 'watch', score: 55, washLikely: true },
      ] }));
    }
    if (url.includes('/pools/multi/')) {
      const data = [];
      if (url.includes(PL)) data.push({ attributes: { address: PL, base_token_price_usd: String(px), reserve_in_usd: '50000', market_cap_usd: String(150000 * px) } });
      if (url.includes('0xpp')) data.push({ attributes: { address: '0xpp', base_token_price_usd: String(pumpPx), reserve_in_usd: '80000', market_cap_usd: '400000' } });
      return new Response(JSON.stringify({ data }));
    }
    return new Response('{}', { status: 404 });
  };
  let pumpPx = 1;
  const last = () => sent.at(-1).b;
  const tap = (data, menuText = 'PAPER · x') => W.handleCallback(env, { id: 'cq', data, message: { chat: { id: 111 }, message_id: 5, text: menuText } });

  // /paper → main menu with the 5 buttons
  await worker.fetch(new Request('https://w.dev/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ message: { chat: { id: 111 }, text: '/paper' } }) }), env);
  const kbText = last().reply_markup.inline_keyboard.flat().map((b) => b.text).join('|');
  for (const k of ['Place trade', 'TP / SL', 'Positions', 'Wallet', 'P/L']) assert.ok(kbText.includes(k), k);
  assert.match(last().text, /Wallet \$30\.00/);

  // Place trade lists candidates (wash coin hidden)
  await tap('pt');
  assert.equal(last().text.includes('WASH'), false);
  assert.match(last().text, /\$CATX — buy · 71\/100/);

  // tapping Paper buy on a scanner alert opens a NEW message, not an edit
  await tap(`pc:${TK}`, '🟢 BUY ZONE · $CATX — 71/100');
  assert.equal(sent.at(-1).m, 'sendMessage');
  assert.match(last().text, /🎯 3x = \$450\.0k mc · 10x = \$1\.5M mc/);

  // buy $10 → position opens, $20 cash left
  await tap(`pb:${TK}:10`);
  let st = JSON.parse(kv.get('paper'));
  assert.equal(st.positions.length, 1);
  assert.ok(Math.abs(st.cash - 20) < 1e-9);
  assert.equal(sent.at(-1).m, 'editMessageText');

  // move SL to breakeven, then price runs to 3.2x → cron sells 50%
  await tap(`pS:${st.positions[0].id}:-25`);
  px = 3.2;
  let evs = await W.paperTick(env);
  assert.ok(evs.some((e) => e.why === 'take profit 3x'));
  st = JSON.parse(kv.get('paper'));
  assert.ok(Math.abs(st.positions[0].rem - 0.5) < 1e-9);
  assert.match(sent.map((x) => x.b.text).join('\n'), /take profit 3x: sold 50%/);

  // peak 4, then drops 45% → trailing stop closes the rest
  px = 4; await W.paperTick(env);
  px = 2.2; evs = await W.paperTick(env);
  st = JSON.parse(kv.get('paper'));
  assert.equal(st.positions.length, 0);
  assert.equal(st.closed.length, 1);
  assert.ok(st.closed[0].pnl > 0);
  assert.match(sent.map((x) => x.b.text).join('\n'), /Paper trade closed · \$CATX/);

  // limit order on the pumping coin: cash reserved, fills when price dips to the limit
  await tap('pl:0xpump');
  st = JSON.parse(kv.get('paper'));
  assert.equal(st.orders.length, 1);
  const cashBefore = st.cash;
  pumpPx = 0.85; await W.paperTick(env);
  assert.equal(JSON.parse(kv.get('paper')).orders.length, 1, 'filled too early');
  pumpPx = 0.79; await W.paperTick(env);
  st = JSON.parse(kv.get('paper'));
  assert.equal(st.orders.length, 0);
  assert.equal(st.positions.length, 1);
  assert.ok(Math.abs(st.positions[0].entry - 0.8 * 1.03) < 1e-9);
  assert.ok(Math.abs(st.cash - cashBefore) < 1e-9);

  // P/L and wallet screens
  await tap('pnl');
  assert.match(last().text, /1 closed trade\(s\) · 1 winner\(s\)/);
  await tap('w');
  assert.match(last().text, /In open positions/);

  // default TP/SL settings change
  await tap('ss:-35');
  assert.equal(JSON.parse(kv.get('paper')).settings.sl, -35);

  // strangers can't press buttons
  const before = kv.get('paper');
  await W.handleCallback(env, { id: 'x', data: 'wry', message: { chat: { id: 999 }, message_id: 1, text: 'PAPER · x' } });
  assert.equal(kv.get('paper'), before);

  // reset
  await tap('wry');
  assert.equal(JSON.parse(kv.get('paper')).cash, 30);
  globalThis.fetch = prevFetch;
});

await test('paper prices: GeckoTerminal blocked → falls back to last scan price, else explains why', async () => {
  const W = await import('../worker/worker.js');
  const kv = new Map();
  const env = { TELEGRAM_BOT_TOKEN: 'T', ALLOWED_CHAT_ID: '111', GITHUB_REPO: 'itsloashh/hood-scanner', PAPER: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => kv.set(k, v) } };
  const sent = [];
  let candAt = new Date().toISOString();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('api.telegram.org')) { sent.push({ m: url.split('/').pop(), b: JSON.parse(init.body || '{}') }); return new Response('{"ok":true}'); }
    if (url.includes('geckoterminal')) return new Response('blocked', { status: 403 });
    if (url.includes('candidates.json')) return new Response(JSON.stringify({ coins: [{ token: '0xgen', symbol: 'GENESIS', pool: '0xgp', tier: 'watch', score: 60, price: 0.002, mcap: 120000, at: candAt }] }));
    return new Response('{}', { status: 404 });
  };
  const tap = (data) => W.handleCallback(env, { id: 'c', data, message: { chat: { id: 111 }, message_id: 1, text: 'PAPER · x' } });
  await tap('pc:0xgen');
  assert.match(sent.at(-1).b.text, /Price \$0\.00200 · market cap \$120\.0k \(from the last scan\)/);
  await tap('pb:0xgen:5');
  assert.equal(JSON.parse(kv.get('paper')).positions.length, 1);
  // scan price too old → clear error naming the cause
  candAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
  await tap('pb:0xgen:5');
  const toast = sent.filter((x) => x.m === 'answerCallbackQuery').at(-1).b.text;
  assert.match(toast, /GeckoTerminal HTTP 403/);
  // coin not in the scan list + GeckoTerminal blocked → DexPaprika finds it and prices it
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('api.telegram.org')) { sent.push({ m: url.split('/').pop(), b: JSON.parse(init.body || '{}') }); return new Response('{"ok":true}'); }
    if (url.includes('geckoterminal')) return new Response('blocked', { status: 403 });
    if (url.includes('candidates.json')) return new Response(JSON.stringify({ coins: [] }));
    if (url.includes('dexpaprika.com/networks/robinhood/tokens/0x' + 'a'.repeat(40))) return new Response(JSON.stringify({ symbol: 'WORM', summary: { price_usd: 0.00099, liquidity_usd: 139000, fdv: 986000 } }));
    if (url.includes('dexpaprika.com/networks/robinhood/pools/search')) return new Response(JSON.stringify({ pools: [{ id: '0x' + 'b'.repeat(40) }] }));
    return new Response('{}', { status: 404 });
  };
  const before = JSON.parse(kv.get('paper')).positions.length;
  await tap('pb:0x' + 'a'.repeat(40) + ':p10');
  const p = JSON.parse(kv.get('paper'));
  assert.equal(p.positions.length, before + 1, JSON.stringify(sent.at(-1)));
  assert.equal(p.positions.at(-1).symbol, 'WORM');
  globalThis.fetch = prevFetch;
});

await test('case studies: finds launch runs and later base-breakout runs, judges them against our rules', async () => {
  const { findRuns, wouldScannerCatch } = await import('../research/case-studies.js');
  const D = 86_400_000;
  const mk = (i, c, extra = {}) => ({ t: i * D, o: c, h: c * 1.03, l: c * 0.97, c, v: 1000, ...extra });
  const cs = [mk(0, 1, { o: 0.2, l: 0.2, h: 1.2 })]; // launch day: 0.2 → 1.2 (6x)
  for (let i = 1; i < 10; i++) cs.push(mk(i, 1 - i * 0.07)); // bleeds to ~0.37
  for (let i = 10; i < 30; i++) cs.push(mk(i, 0.35 + (i % 2) * 0.02)); // base
  for (let i = 30; i < 40; i++) cs.push(mk(i, 0.35 * (1 + (i - 29) * 0.4), { v: 6000 })); // run to ~1.75 (5x)
  for (let i = 40; i < 60; i++) cs.push(mk(i, 1.2));
  const runs = findRuns(cs, { mcapFactor: 100_000 });
  assert.equal(runs.length, 2, JSON.stringify(runs.map((r) => [r.start / D, r.peakX])));
  assert.equal(runs[0].isLaunchRun, true);
  assert.ok(runs[0].peakX >= 5);
  assert.ok(runs[1].ageDays >= 25 && runs[1].peakX >= 3);
  assert.ok(runs[1].volIgnition >= 3);
  assert.equal(wouldScannerCatch(runs[0]).caught, false); // too young
  assert.equal(wouldScannerCatch(runs[1]).caught, true); // 29d old, ~$36k mc
});

await test('lanes: quality coins need real holders and a real crash; micro coins get a size warning', async () => {
  const { deepFilter, laneChartCheck, laneOf } = await import('../src/filters.js');
  const base = { info: { twitter: 'x', isHoneypot: false, devPct: 0 }, conc: { top10Pct: 20, top1Pct: 3 }, community: { flags: [] } };
  assert.equal(laneOf(200_000), 'micro');
  assert.equal(laneOf(3_600_000), 'quality');
  assert.equal(deepFilter({ ...base, holdersCount: 16_576, lane: 'quality', marketCap: 3_610_000 }).ok, true); // FRONG at its second leg
  assert.match(deepFilter({ ...base, holdersCount: 900, lane: 'quality', marketCap: 3_000_000 }).reasons.join(), /under 5,000 holders/);
  assert.match(deepFilter({ ...base, holdersCount: 1_600_000, lane: 'quality', marketCap: 2_000_000 }).reasons.join(), /padded/);
  assert.equal(deepFilter({ ...base, holdersCount: 900, lane: 'micro', marketCap: 100_000 }).ok, true);
  assert.equal(laneChartCheck('quality', { drawdownPct: 79 }), null);
  assert.match(laneChartCheck('quality', { drawdownPct: 30 }), /only 30% off/);
  assert.match(laneChartCheck('quality', { drawdownPct: 96 }), /too broken/);
  assert.equal(laneChartCheck('micro', { drawdownPct: 99 }), null);
});

await test('quiet base: volume drying up in a sideways base scores; a dead flatline or a pump does not', async () => {
  const { chartFeatures, quietBaseScore, scoreCoin } = await import('../src/score.js');
  const D = 86_400_000;
  const cs = [{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 9000 }];
  for (let i = 1; i < 20; i++) cs.push({ t: i * D, o: 0.25, h: 0.27, l: 0.23, c: 0.25 + (i % 2) * 0.01, v: 3000 });
  for (let i = 20; i < 24; i++) cs.push({ t: i * D, o: 0.25, h: 0.26, l: 0.24, c: 0.25, v: 1500 }); // drying up (last 3 full days)
  const ch = chartFeatures(cs, 0.25);
  assert.ok(ch.volTrend > 0.4 && ch.volTrend < 0.6, `volTrend ${ch.volTrend}`);
  assert.ok(quietBaseScore(ch) >= 4);
  assert.equal(quietBaseScore({ ...ch, volTrend: 1.4 }), 0); // volume rising = not quiet
  assert.equal(quietBaseScore({ ...ch, drawdownPct: 20 }), 0); // never crashed
  assert.equal(quietBaseScore({ ...ch, baseRange: 3 }), 0); // choppy
  const pool = { baseToken: { symbol: 'Q', name: 'Q' }, marketCap: 100_000, liquidityUsd: 15_000, volume24h: 1500, buyers24h: 20, sellers24h: 15, change: { h24: 1 } };
  const sc = scoreCoin({ pool, holdersCount: 800, conc: { top10Pct: 20, top1Pct: 3 }, socials: 2, chart: ch, holderChangePct: 0, rotation: {}, stockPaired: false, community: {} });
  assert.ok(sc.parts.quietBase >= 4);
});

await test('catalysts: manual tag, buybacks and chain identity add up to +8 max', async () => {
  const { catalystScore } = await import('../src/score.js');
  const pool = { baseToken: { symbol: 'HOODCAT', name: 'Hood Cat' } };
  const c = catalystScore({ manual: { note: 'Robinhood app listing' }, burns: { recent: { count: 5 } }, pool, info: {} });
  assert.equal(c.pts, 8);
  assert.equal(c.why.length, 3);
  assert.equal(catalystScore({ manual: null, burns: { recent: { count: 1 } }, pool: { baseToken: { symbol: 'ZZZ', name: 'zz' } }, info: {} }).pts, 0);
  const { applyCatalyst } = await import('../scripts/catalyst.js');
  const file = path.join(process.env.DATA_DIR, 'catalysts.json');
  const CA = '0x6245e67affa44a23077f0ea7f981a8dc743a0c47';
  applyCatalyst(file, CA.toUpperCase().replace('0X', '0x'), 'Robinhood Crypto listing');
  const { loadCatalysts } = await import('../src/index.js');
  assert.equal(loadCatalysts()[CA].note, 'Robinhood Crypto listing');
  assert.deepEqual(loadCatalysts(Date.now() + 15 * 86_400_000), {}); // expires after 14 days
  applyCatalyst(file, CA, 'remove');
  assert.deepEqual(loadCatalysts(), {});
  assert.throws(() => applyCatalyst(file, 'nope', 'x'));
});

await test('copycats: same ticker, different contract is rejected; the real one passes', async () => {
  const { copycatOf, buildKnownTickers } = await import('../src/filters.js');
  const known = buildKnownTickers({ GOODCAT: ['0xaaa'] });
  const mk = (sym, a) => ({ baseToken: { symbol: sym, address: a } });
  assert.match(copycatOf(mk('PONS', '0x1234567890123456789012345678901234567890'), known), /copycat of \$PONS/);
  assert.equal(copycatOf(mk('$pons', '0x39dbed3a2bd333467115de45665cc57f813c4571'), known), null);
  assert.match(copycatOf(mk('goodcat', '0xbbb'), known), /copycat/);
  assert.equal(copycatOf(mk('NEWCOIN', '0xccc'), known), null);
});

await test('ignition: hourly volume 5×+ out of a quiet base fires; a dump, an already-run coin or dead hours do not', async () => {
  const { ignitionSignal } = await import('../src/index.js');
  const base = { baseHourVol: 100, baseHigh: 1.0 };
  const h = (o, c, v) => ({ o, h: Math.max(o, c), l: Math.min(o, c), c, v });
  const quiet = Array.from({ length: 21 }, (_, i) => h(0.9, 0.9, 90 + (i % 3) * 10));
  const fire = [...quiet, h(0.9, 0.95, 600), h(0.95, 1.05, 900), h(1.05, 1.1, 700)];
  assert.equal(ignitionSignal(base, fire).fired, true);
  assert.ok(ignitionSignal(base, fire).mult > 5);
  assert.equal(ignitionSignal(base, quiet).fired, false);
  const dump = [...quiet, h(0.9, 0.8, 600), h(0.8, 0.7, 900), h(0.7, 0.6, 700)];
  assert.equal(ignitionSignal(base, dump).fired, false); // volume on a sell-off isn't ignition
  assert.equal(ignitionSignal(base, fire, { priceNow: 1.9, movePct: 90 }).fired, false); // already 90% above the base
  // DexPaprika candles: units differ from GeckoTerminal, so only the series' own normal hour is used,
  // and price comes from the live USD pool price
  const dpUnits = fire.map((k) => ({ ...k, v: k.v * 1000, o: 1 / k.o, c: 1 / k.c }));
  assert.equal(ignitionSignal(base, dpUnits, { priceNow: 0.98, movePct: 12 }).fired, true);
  // mostly dead hours + one normal trade can't fake a huge multiple
  const dead = [...Array.from({ length: 18 }, () => h(0.9, 0.9, 0)), h(0.9, 0.9, 400), h(0.9, 0.9, 400), h(0.9, 0.9, 400), h(0.9, 0.95, 120), h(0.95, 1, 120), h(1, 1, 120)];
  assert.equal(ignitionSignal(base, dead).fired, false);
  const { ignitionMessage } = await import('../src/messages.js');
  const msg = ignitionMessage({ token: '0x6245e67affa44a23077f0ea7f981a8dc743a0c47', base: { ...base, symbol: 'FRONG', pool: '0xp', lane: 'quality', drawdownPct: 79, volTrend: 0.51 }, sig: ignitionSignal(base, fire), pool: { marketCap: 3_600_000, liquidityUsd: 400_000 } });
  assert.match(msg, /IGNITION · \$FRONG/);
  assert.match(msg, /Quality lane/);
});

await test('dexpaprika: hourly candles parsed oldest → newest', async () => {
  const dpm = await import('../src/dexpaprika.js');
  const prevFetch = globalThis.fetch;
  let seen = '';
  globalThis.fetch = async (url) => {
    seen = String(url);
    return new Response(JSON.stringify([
      { time_open: '2026-10-17T02:00:00Z', time_close: '2026-10-17T03:00:00Z', open: 2, high: 3, low: 1, close: 2.5, volume: 50 },
      { time_open: '2026-10-17T01:00:00Z', time_close: '2026-10-17T02:00:00Z', open: 1, high: 2, low: 1, close: 2, volume: 10 },
    ]));
  };
  try {
    const k = await dpm.hourly('0xpool', 24);
    assert.match(seen, /api\.dexpaprika\.com\/networks\/robinhood\/pools\/0xpool\/ohlcv\?start=-24h&interval=1h/);
    assert.equal(k.length, 2);
    assert.ok(k[0].t < k[1].t);
    assert.equal(k[1].v, 50);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

await test('paper sizes are % of the wallet, and the starting amount can be changed', async () => {
  const worker = (await import('../worker/worker.js')).default;
  const kv = new Map();
  const env = { TELEGRAM_BOT_TOKEN: 'T', ALLOWED_CHAT_ID: '111', GITHUB_TOKEN: 'G', WEBHOOK_SECRET: 's', GITHUB_REPO: 'x/y',
    PAPER: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => kv.set(k, v) } };
  const sent = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('api.telegram.org')) {
      sent.push(JSON.parse(init.body || '{}'));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    if (url.includes('/dispatches')) {
      sent.push({ dispatched: url.split('/workflows/')[1].split('/')[0], body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    return new Response('nope', { status: 404 });
  };
  const tap = (data) => worker.fetch(new Request('https://b/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's' },
    body: JSON.stringify({ callback_query: { id: '1', data, message: { chat: { id: 111 }, message_id: 1, text: 'PAPER · x' } } }) }), env);
  const say = (text) => worker.fetch(new Request('https://b/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's' },
    body: JSON.stringify({ message: { chat: { id: 111 }, text } }) }), env);
  try {
    await tap('wr');
    const kb = JSON.stringify(sent.at(-1).reply_markup);
    assert.match(kb, /wry:1000/);
    await tap('wry:1000');
    const p = JSON.parse(kv.get('paper'));
    assert.equal(p.start, 1000);
    assert.equal(p.cash, 1000);
    await say('/catalyst 0x6245e67affa44a23077f0ea7f981a8dc743a0c47 Robinhood app listing');
    const d = sent.find((x) => x.dispatched === 'catalyst.yml');
    assert.deepEqual(d.body.inputs, { ca: '0x6245e67affa44a23077f0ea7f981a8dc743a0c47', note: 'Robinhood app listing' });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

console.log = origLog;
console.log(`\n${failures ? `${failures} test(s) failed` : 'all tests passed'} · ${calls.length} mocked API calls`);
process.exit(failures ? 1 : 0);
