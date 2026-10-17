// Coins that are already pumping: don't chase — work out the likely pullback and
// where to put a limit buy, using what pumps on Robinhood Chain have actually done
// (data/research/pullbacks.json, rebuilt by the daily research job).
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { DATA_DIR } from './store.js';

// Textbook fallback when there isn't enough chain history yet (Fibonacci 38–50%).
const GENERIC = { retraceP25: 0.382, retraceMedian: 0.5, retraceP75: 0.618, pPullback30: null, pNewHigh14: null, pFullRetrace: null, n: 0 };

export function loadPullbacks() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'research', 'pullbacks.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function bucketKey(gain) {
  if (gain >= 2) return '200+';
  if (gain >= 1) return '100-200';
  return '50-100';
}

// pool: current pool data · candles: daily candles (oldest → newest) · stats: pullbacks.json
export function pumpPlan({ pool, candles, stats }) {
  const price = pool.priceUsd;
  const ch = (pool.change.h24 ?? 0) / 100;
  if (!price || ch <= 0) return null;
  const base = price / (1 + ch); // where the pump started (price 24h ago)
  const recentHighs = (candles || []).slice(-2).map((c) => c.h);
  const peak = Math.max(price, ...recentHighs.filter((h) => h > 0 && h < price * 5)); // ignore bad ticks
  const gain = peak / base - 1;
  const key = bucketKey(gain);
  const b = stats?.buckets?.[key];
  const proven = Boolean(b && b.n >= CONFIG.pump.minExamples);
  const s = proven ? b : GENERIC;
  const move = peak - base;
  const entryTop = peak - s.retraceP25 * move; // shallow pullback
  const entryMid = peak - s.retraceMedian * move; // typical pullback = main limit price
  const entryDeep = peak - s.retraceP75 * move; // deep pullback
  const stop = base * (1 - CONFIG.pump.stopBelowBasePct / 100); // whole pump failed
  const offPeak = 1 - price / peak;
  const status = price <= entryDeep ? 'deep' : price <= entryTop ? 'in-zone' : 'above';
  const mcapAt = (px) => (pool.marketCap && price ? (pool.marketCap * px) / price : null);
  return {
    key, gain, base, peak, price, offPeak, status, proven, n: s.n,
    pPullback30: s.pPullback30, pNewHigh14: s.pNewHigh14, pFullRetrace: s.pFullRetrace,
    retraceMedian: s.retraceMedian, medianDaysToLow: proven ? b.medianDaysToLow : null,
    entryTop, entryMid, entryDeep, stop,
    riskPct: (1 - stop / entryMid) * 100,
    target3x: entryMid * 3, target10x: entryMid * 10,
    mcapEntry: mcapAt(entryMid), mcap3x: mcapAt(entryMid * 3), mcap10x: mcapAt(entryMid * 10),
  };
}
