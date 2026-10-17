// Offline tests: fake GeckoTerminal + Blockscout responses, run a full scan,
// and check the filters, scoring, alerting and paper trading behave.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hood-test-'));
process.env.DRY_RUN = '1';

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
  if (url.includes('/info')) {
    const c = find(url);
    return ok({ data: { attributes: { holders: { count: 900 }, twitter_handle: c.sym.toLowerCase(), telegram_handle: null, websites: ['https://x.example'], is_honeypot: 'no', developer_holding_percentage: '1.5', developer_address: addr(5001) } } });
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
  assert.match(quickFilter(mk(coins.big), now).reasons.join(), /mcap >/);
  assert.match(quickFilter(mk({ ...coins.good, mcap: 334_000 }), now).reasons.join(), /mcap >/);
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
  assert.equal(stats1.alerts, 1, `alerts ${stats1.alerts}\n${out.slice(-3000)}`);
  assert.match(out, /HOOD SCANNER — \$GOODCAT/);
  if (process.env.SHOW_ALERT) origLog(out.slice(out.indexOf('──── ALERT')));
  assert.doesNotMatch(out, /HOOD SCANNER — \$WHALEINU/);
  assert.doesNotMatch(out, /HOOD SCANNER — \$NEWDOG/);
  const state = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'state.json'), 'utf8'));
  assert.equal(state.paper.positions.length, 1);
  assert.ok(Math.abs(state.paper.positions[0].sizeUsd - 10) < 0.01);
  assert.ok(Math.abs(state.paper.cash - 20) < 0.01);
});

await test('snapshot logger wrote the research dataset', () => {
  const month = new Date(now).toISOString().slice(0, 7);
  const csv = fs.readFileSync(path.join(process.env.DATA_DIR, 'snapshots', `${month}.csv`), 'utf8');
  const rows = csv.trim().split('\n');
  assert.ok(rows.length >= 4, `rows ${rows.length}`);
  assert.match(csv, /GOODCAT.*ALERT/);
  assert.match(csv, /WHALEINU.*top wallet/);
});

await test('second run does not re-alert the same coin (cooldown)', async () => {
  printed.length = 0;
  const s = await main();
  assert.equal(s.alerts, 0);
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

console.log = origLog;
console.log(`\n${failures ? `${failures} test(s) failed` : 'all tests passed'} · ${calls.length} mocked API calls`);
process.exit(failures ? 1 : 0);
