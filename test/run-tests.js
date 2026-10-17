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
fs.writeFileSync(path.join(process.env.DATA_DIR, 'wallets.json'), JSON.stringify({ wallets: {}, tokens: {}, seeded: { [SMART]: { wins: 3, duds: 0, coins: ['OLDCAT'] } } }));

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
const test = async (name, fn) => {
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
  assert.match(quickFilter(mk(coins.big), now).reasons.join(), /mcap over max/);
  assert.match(quickFilter(mk({ ...coins.good, mcap: 334_000 }), now).reasons.join(), /mcap over max/);
  assert.equal(quickFilter(mk({ ...coins.good, mcap: 333_000 }), now).ok, true);
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
await test('full scan alerts on the good coin only and opens a $10 paper position', async () => {
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
  const state = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'state.json'), 'utf8'));
  assert.equal(state.paper.positions.length, 1);
  assert.ok(Math.abs(state.paper.positions[0].sizeUsd - 10) < 0.01);
  assert.ok(Math.abs(state.paper.cash - 20) < 0.01);
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
  // organic flow: many different wallets, few on both sides
  const org = [];
  for (let i = 0; i < 120; i++) org.push({ wallet: `0xo${i}`, kind: i % 4 ? 'buy' : 'sell', usd: 40, ts: i * 60_000, block: 1000 + i });
  assert.equal(wm.flowFeatures(org, { wallets: {}, seeded: {} }).washLikely, false);
});

console.log = origLog;
console.log(`\n${failures ? `${failures} test(s) failed` : 'all tests passed'} · ${calls.length} mocked API calls`);
process.exit(failures ? 1 : 0);
