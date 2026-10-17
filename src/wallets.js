// Wallet intelligence.
//
// Every run, for coins that pass the junk filter, we pull the last 24h of trades
// (free, GeckoTerminal) and record which wallets bought, when, and at what price.
// As later runs see the price move, each buy resolves as a WIN (hit 3x within 30
// days) or a LOSS (fell 60% first, or ran out of time). Wallets that keep winning
// become "smart wallets", and the scanner flags coins they are buying now.
//
// The weekly research job (research/reverse-engineer.js) seeds this list from past
// runners on the chain, so it doesn't have to start from zero.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { DATA_DIR } from './store.js';

const DAY = 86_400_000;
const FILE = () => path.join(DATA_DIR, 'wallets.json');

// Smart wallets found by the research job live in their own file (owned by research),
// so the two jobs never write the same file.
export function loadSeeds() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'research', 'smart-wallets.json'), 'utf8'));
    return Object.fromEntries((j.wallets || []).map((x) => [x.addr, { wins: x.wins, duds: x.duds, coins: x.coins }]));
  } catch {
    return {};
  }
}

export function loadWallets() {
  let w;
  try {
    w = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    w.wallets ||= {};
    w.tokens ||= {};
  } catch {
    w = { wallets: {}, tokens: {}, updatedAt: null };
  }
  w.seeded = { ...(w.seeded || {}), ...loadSeeds() };
  return w;
}

export function saveWallets(w, now = Date.now()) {
  const c = CONFIG.wallets;
  // keep the file bounded: drop wallets with no activity in 60 days and no wins,
  // then keep the most recently active up to maxWallets
  let entries = Object.entries(w.wallets).filter(([, v]) => v.wins > 0 || now - v.last < 60 * DAY);
  if (entries.length > c.maxWallets) {
    entries.sort((a, b) => b[1].wins - a[1].wins || b[1].last - a[1].last);
    entries = entries.slice(0, c.maxWallets);
  }
  w.wallets = Object.fromEntries(entries);
  w.updatedAt = new Date(now).toISOString();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { seeded, ...rest } = w; // seeds are re-read from the research file each run
  fs.writeFileSync(FILE(), JSON.stringify(rest));
}

export function isSmart(v) {
  if (!v) return false;
  const c = CONFIG.wallets;
  const resolved = v.wins + v.losses;
  return !v.bot && v.wins >= c.smartMinWins && resolved > 0 && v.wins / resolved >= c.smartMinHitRate;
}

export const smartWallets = (w) =>
  Object.entries(w.wallets).filter(([a, v]) => isSmart(v) || w.seeded[a]).map(([a]) => a);

// Record new trades for one token. Returns the trades that were new this run.
export function ingestTrades(w, token, symbol, trades, now = Date.now()) {
  const t = (w.tokens[token] ||= { symbol, lastTs: 0 });
  t.symbol = symbol;
  const fresh = trades.filter((x) => x.ts > t.lastTs);
  for (const tr of fresh) {
    const v = (w.wallets[tr.wallet] ||= { first: tr.ts, last: tr.ts, buys: [], wins: 0, losses: 0, recent: [] });
    v.last = Math.max(v.last, tr.ts);
    if (tr.kind !== 'buy' || !tr.priceUsd) continue;
    // one tracked buy per wallet per token at a time (first entry is what matters)
    if (!v.buys.some((b) => b.tk === token && !b.r)) {
      v.buys.push({ tk: token, t: tr.ts, p: tr.priceUsd, usd: Math.round(tr.usd), hi: 1, lo: 1 });
      if (v.buys.length > 40) v.buys = v.buys.filter((b) => !b.r).slice(-40);
    }
    // spray-bot detection: distinct tokens bought in the last 24h
    v.recent = [...(v.recent || []).filter((r) => r[1] > now - DAY && r[0] !== token), [token, tr.ts]];
    if (v.recent.length > CONFIG.wallets.sprayMaxTokensPerDay) v.bot = true;
  }
  if (fresh.length) t.lastTs = Math.max(...fresh.map((x) => x.ts));
  return fresh;
}

// Mark every open buy to market and resolve wins/losses.
// prices: { [token]: priceUsd }
export function resolveOutcomes(w, prices, now = Date.now()) {
  const c = CONFIG.wallets;
  const resolved = [];
  for (const [addr, v] of Object.entries(w.wallets)) {
    for (const b of v.buys) {
      if (b.r) continue;
      const px = prices[b.tk];
      if (px) {
        const x = px / b.p;
        b.hi = Math.max(b.hi, x);
        b.lo = Math.min(b.lo, x);
      }
      if (b.hi >= c.winMultiple) {
        b.r = 'W';
        v.wins += 1;
        resolved.push({ addr, ...b });
      } else if (b.lo <= 1 + c.lossDrawdownPct / 100 || now - b.t > c.winWindowDays * DAY) {
        b.r = 'L';
        v.losses += 1;
        resolved.push({ addr, ...b });
      }
    }
  }
  return resolved;
}

// Buy-flow features from one pool's 24h trades — the "who is buying" picture.
export function flowFeatures(trades, w) {
  const c = CONFIG.wallets;
  if (!trades?.length) return null;
  const buys = trades.filter((t) => t.kind === 'buy');
  const sells = trades.filter((t) => t.kind === 'sell');
  const buyers = new Map();
  for (const b of buys) buyers.set(b.wallet, (buyers.get(b.wallet) || 0) + 1);
  const sellers = new Set(sells.map((s) => s.wallet));

  const byBlock = new Map();
  for (const b of buys) {
    if (b.block == null) continue;
    if (!byBlock.has(b.block)) byBlock.set(b.block, new Set());
    byBlock.get(b.block).add(b.wallet);
  }
  let bundledBuys = 0;
  for (const b of buys) if (b.block != null && byBlock.get(b.block).size >= c.bundleMinWallets) bundledBuys += 1;

  // Wash trading / volume bots: the same small group buying AND selling over and over.
  const traders = new Set([...buyers.keys(), ...sellers]);
  const both = [...buyers.keys()].filter((a) => sellers.has(a)).length;
  const overlap = traders.size ? both / traders.size : 0; // share of wallets doing both sides
  const tradesPerWallet = traders.size ? trades.length / traders.size : 0;
  const repeatShare = buyers.size ? [...buyers.values()].filter((n) => n >= 2).length / buyers.size : 0;
  const balanced = Math.max(buyers.size, sellers.size) > 0 && Math.abs(buyers.size - sellers.size) / Math.max(buyers.size, sellers.size) <= 0.1;
  const washSignals = [
    overlap >= 0.45 ? `${Math.round(overlap * 100)}% of wallets both bought and sold` : null,
    tradesPerWallet >= 4 ? `${tradesPerWallet.toFixed(1)} trades per wallet` : null,
    balanced && repeatShare >= 0.6 ? 'buyers and sellers almost exactly equal, mostly repeat buyers' : null,
  ].filter(Boolean);

  const sizes = buys.map((b) => b.usd).sort((a, b) => a - b);
  const buyUsd = buys.reduce((s, b) => s + b.usd, 0);
  const sellUsd = sells.reduce((s, b) => s + b.usd, 0);
  const smart = [...buyers.keys()].filter((a) => isSmart(w?.wallets[a]) || w?.seeded[a]);
  const bots = [...buyers.keys()].filter((a) => w?.wallets[a]?.bot);
  const span = (trades.at(-1).ts - trades[0].ts) / 3_600_000;

  return {
    windowHours: Math.max(1, Math.round(span)),
    trades: trades.length,
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    repeatBuyers: [...buyers.values()].filter((n) => n >= 2).length,
    buyUsd: Math.round(buyUsd),
    sellUsd: Math.round(sellUsd),
    netFlowUsd: Math.round(buyUsd - sellUsd),
    medianBuyUsd: sizes.length ? Math.round(sizes[Math.floor(sizes.length / 2)]) : 0,
    whaleBuys: buys.filter((b) => b.usd >= c.whaleBuyUsd).length,
    bundledShare: buys.length ? bundledBuys / buys.length : 0,
    botBuyers: bots.length,
    smartBuyers: smart,
    overlap: Math.round(overlap * 100) / 100,
    tradesPerWallet: Math.round(tradesPerWallet * 10) / 10,
    // likely wash/volume bot when 2+ signals agree (or overlap+churn are extreme)
    washLikely: washSignals.length >= 2 || (overlap >= 0.8 && tradesPerWallet >= 3),
    washSignals,
  };
}
