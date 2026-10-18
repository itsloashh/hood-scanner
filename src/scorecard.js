// ALERT SCORECARD — the honest measure of the bot: what happened after every alert.
// Each alert is followed at every scan (15-min price snapshots) for 30 days:
//   ✅ win      reached 3x from the alert price
//   ❌ stopped  fell 50% before reaching 3x
//   ⏹ expired   30 days passed without either (finalX = where it ended)
import { CONFIG } from '../config.js';

const DAY = 86_400_000;

export function recordAlert(card, { token, symbol, tier, lane, price, score, kind = null, ethTrend = null, mcap = null, pool = null }, now = Date.now()) {
  if (!price || !token) return false;
  if (card.some((a) => a.token === token && a.tier === tier && !a.outcome)) return false; // already tracking this setup
  card.push({ token, symbol, tier, lane: lane || null, kind, ethTrend, score: score ?? null, at: now, price, mcap: mcap ? Math.round(mcap) : null, pool, peakX: 1, lowX: 1, lastX: 1, outcome: null });
  if (card.length > CONFIG.scorecard.maxEntries) card.splice(0, card.length - CONFIG.scorecard.maxEntries);
  return true;
}

export function updateScorecard(card, prices, now = Date.now()) {
  const done = [];
  for (const a of card) {
    if (a.outcome) continue;
    const p = prices[a.token];
    if (p > 0) {
      const x = p / a.price;
      a.lastX = x;
      a.peakX = Math.max(a.peakX, x);
      a.lowX = Math.min(a.lowX, x);
      if (a.peakX >= CONFIG.scorecard.winX) a.outcome = 'win';
      else if (a.lowX <= CONFIG.scorecard.stopX) a.outcome = 'stopped';
    }
    if (!a.outcome && now - a.at > CONFIG.scorecard.days * DAY) a.outcome = 'expired';
    if (a.outcome) {
      a.closedAt = now;
      done.push(a);
    }
  }
  return done;
}

// by = how to group: tier+lane (default), or e.g. a => a.kind / a => `ETH ${a.ethTrend}`
export function summarize(card, by = (a) => `${a.tier}${a.lane ? `/${a.lane}` : ''}`) {
  const groups = {};
  for (const a of card) {
    const k = by(a) || 'unknown';
    const g = (groups[k] ||= { n: 0, win: 0, stopped: 0, expired: 0, open: 0, hit2x: 0, peakSum: 0 });
    g.n += 1;
    g[a.outcome || 'open'] += 1;
    if (a.peakX >= 2) g.hit2x += 1;
    g.peakSum += a.peakX;
  }
  for (const g of Object.values(groups)) {
    const closed = g.win + g.stopped + g.expired;
    g.winRate = closed ? g.win / closed : null;
    g.avgPeakX = g.n ? g.peakSum / g.n : null;
    delete g.peakSum;
  }
  return groups;
}
