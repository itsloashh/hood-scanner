// Winner profile — what our 2× calls looked like the day before they ran (Oct 17–27 study).
// Revival winners (CANNACAT): older coin, buyers back (60+/day, more buyers than sellers),
// volume 2×+ its weekly average, price turning up but not ripping yet.
// Losers mostly had volume under their average and buyers ≈ sellers. Re-check as data grows.
import { CONFIG } from '../config.js';

export function winnerProfile(pool, score, lane) {
  const P = CONFIG.profile;
  if (!P?.enabled || !P.lanes.includes(lane)) return { ok: true, misses: [] };
  const misses = [];
  const b = pool.buyers24h ?? 0;
  const s = pool.sellers24h ?? 0;
  const ch = pool.change?.h24 ?? 0;
  const vr = score?.volRatio;
  if (b < P.minBuyers24h) misses.push(`only ${b} buyers today (winners had ${P.minBuyers24h}+)`);
  if (s > 0 && b / s < P.minBuySell) misses.push(`buyers/sellers ${(b / s).toFixed(2)} (winners ≥${P.minBuySell})`);
  if (vr == null || vr < P.minVolRatio) misses.push(`volume ${vr == null ? 'unknown' : vr.toFixed(1) + '×'} its weekly avg (winners ${P.minVolRatio}×+)`);
  if (ch < P.change24h[0] || ch > P.change24h[1]) misses.push(`24h move ${ch.toFixed(0)}% (winners ${P.change24h[0]} to +${P.change24h[1]}%)`);
  return { ok: misses.length === 0, misses };
}
