// HOLDERS JOB — fetches top-wallet lists from Blockscout with long timeouts, outside the scan.
// Writes data/holders.json; the scan reads it (src/index.js → holderData). Runs every 30 min.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG } from '../config.js';
import * as bs from './blockscout.js';
import { DATA_DIR, loadState } from './store.js';
import { httpStats } from './http.js';

const HOUR = 3_600_000;
export const HOLDERS_FILE = () => path.join(DATA_DIR, 'holders.json');

export function loadHolders() {
  try {
    return JSON.parse(fs.readFileSync(HOLDERS_FILE(), 'utf8'));
  } catch {
    return { coins: {} };
  }
}

// Which coins need fresh holder data: alerted/scored coins first, then the watchlist
export function pickTargets(state, candidates, holders, now = Date.now()) {
  const fresh = (t) => holders.coins[t] && now - holders.coins[t].at < CONFIG.holdersJob.freshHours * HOUR;
  const order = { ignition: 0, buy: 1, pump: 2, watch: 3, scored: 4 };
  const list = [];
  const seen = new Set();
  for (const c of [...candidates].sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9))) {
    if (seen.has(c.token) || fresh(c.token)) continue;
    seen.add(c.token);
    list.push({ token: c.token, pool: c.pool, symbol: c.symbol });
  }
  for (const [t, w] of Object.entries(state.watchlist || {})) {
    if (seen.has(t) || fresh(t)) continue;
    seen.add(t);
    list.push({ token: t, pool: w.pool, symbol: w.symbol });
  }
  return list.slice(0, CONFIG.holdersJob.maxCoins);
}

export async function main(now = Date.now()) {
  bs.setSlowMode(true);
  const state = loadState();
  let candidates = [];
  try {
    candidates = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'candidates.json'), 'utf8')).coins || [];
  } catch { /* none yet */ }
  const holders = loadHolders();
  holders.coins ||= {};
  const targets = pickTargets(state, candidates, holders, now);
  const report = { at: new Date(now).toISOString(), targets: targets.length, ok: 0, failed: 0, errors: [] };
  for (const t of targets) {
    if (Date.now() - now > CONFIG.holdersJob.budgetMin * 60_000) break;
    try {
      const [meta, list] = [await bs.tokenMeta(t.token), await bs.topHolders(t.token)];
      if (!meta?.totalSupply || !list.length) throw new Error('empty holder data');
      const devAddress = state.infoCache?.[t.token]?.info?.devAddress || null;
      const conc = bs.concentration(list, meta.totalSupply, { poolAddresses: [t.pool].filter(Boolean), devAddress });
      const recentBurns = await bs.recentBurns(t.token, now - CONFIG.burns.recentDays * 86_400_000).catch(() => null);
      holders.coins[t.token] = { at: Date.now(), symbol: t.symbol, holdersCount: meta.holders, conc, recentBurns };
      report.ok += 1;
      console.log(`✓ ${t.symbol}: top1 ${conc.top1Pct.toFixed(1)}% top10 ${conc.top10Pct.toFixed(1)}% · ${meta.holders} holders`);
    } catch (e) {
      report.failed += 1;
      if (report.errors.length < 5) report.errors.push(`${t.symbol}: ${e.message.slice(0, 100)}`);
      console.log(`✗ ${t.symbol}: ${e.message.slice(0, 120)}`);
    }
  }
  // forget entries older than 2 days
  for (const [t, v] of Object.entries(holders.coins)) if (now - v.at > 48 * HOUR) delete holders.coins[t];
  report.http = Object.fromEntries(Object.entries(httpStats).map(([h, v]) => [h, { calls: v.calls, sec: Math.round(v.ms / 1000) }]));
  holders.lastRun = report;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HOLDERS_FILE(), JSON.stringify(holders, null, 1));
  console.log(`holders: ${report.ok} ok, ${report.failed} failed of ${report.targets}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
