// DexPaprika (free, keyless, covers Robinhood Chain). Separate rate limit from GeckoTerminal,
// so hourly ignition checks run here and GeckoTerminal's budget goes to deep checks.
// Keyless tier: hourly candles for the last 24h only — exactly what ignition needs.
import { CONFIG } from '../config.js';
import { getJson } from './http.js';

const base = () => `${CONFIG.dexpaprika.base}/networks/${CONFIG.dexpaprika.network}`;
const opts = () => ({ minIntervalMs: CONFIG.dexpaprika.minIntervalMs, retries: 1 });

// Hourly candles, oldest → newest: [{t, o, h, l, c, v}]. Volume/price units are DexPaprika's own,
// so only compare them with each other (never with GeckoTerminal numbers).
export async function hourly(poolAddress, hours = 24) {
  const q = new URLSearchParams({ start: `-${hours}h`, interval: '1h', limit: String(hours) });
  const list = await getJson(`${base()}/pools/${poolAddress}/ohlcv?${q}`, opts());
  if (!Array.isArray(list)) return [];
  return list
    .map((k) => ({ t: Date.parse(k.time_open), o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume || 0 }))
    .filter((k) => Number.isFinite(k.t))
    .sort((a, b) => a.t - b.t);
}
