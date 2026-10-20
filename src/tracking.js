// CALLED-COIN TRACKING — one full alert per coin, then only short updates when something
// meaningful changes. Your per-coin choice (🔕 mute / ⭐ follow) lives in data/coin-prefs.json,
// set from the Telegram buttons.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { DATA_DIR } from './store.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'coin-prefs.json'), 'utf8')).coins || {};
  } catch {
    return {};
  }
}

// One-time: coins alerted before tracking existed count as already called (no fresh wave of alerts)
export function seedCalled(state) {
  if (state.called) return state.called;
  state.called = {};
  const firstPrice = (t) => (state.scorecard || []).find((e) => e.token === t)?.price ?? null;
  for (const [store, tier] of [[state.watchAlerts, 'watch'], [state.alerts, 'buy']]) {
    for (const [t, v] of Object.entries(store || {})) {
      const c = (state.called[t] ||= { symbol: v.symbol, firstAt: v.at, firstPrice: firstPrice(t), lastSentAt: v.at, lastScore: v.score ?? null, lastTier: tier, lastPrice: firstPrice(t), miss: 0, active: true, milestones: {} });
      if (tier === 'buy') {
        c.lastTier = 'buy';
        c.buyNotified = true;
      }
      c.lastSentAt = Math.max(c.lastSentAt, v.at);
    }
  }
  return state.called;
}

// What to send for a coin that qualifies this run: 'full' alert, a short 'update', or nothing.
//   tier: 'buy' | 'watch' — what it qualifies for now
// Already-called coins stay quiet. The only update a normal coin can get here is the FIRST time
// it reaches the buy zone (once, ever). Big moves are covered by the 2×/3×/−50% milestones.
// ⭐ Followed coins also get score/price changes and a daily check-in.
export function decide(called, prefs, { token, tier, score, price }, now = Date.now()) {
  const T = CONFIG.tracking;
  const mode = prefs[token];
  if (mode === 'mute') return { kind: null, reasons: [] };
  const c = called[token];
  const lastSeen = c ? Math.max(c.lastSeenAt || 0, c.lastSentAt || 0) : 0;
  if (!c || now - lastSeen > T.forgetDays * DAY) return { kind: 'full', reasons: [] };
  const reasons = [];
  if (tier === 'buy' && !c.buyNotified && c.lastTier !== 'buy') reasons.push('reached 🟢 BUY ZONE for the first time');
  if (mode === 'follow') {
    if (c.lastScore != null && Math.abs(score - c.lastScore) >= T.followScoreJump) reasons.push(`score ${c.lastScore} → ${score}`);
    if (c.lastPrice && price) {
      const pct = (price / c.lastPrice - 1) * 100;
      if (Math.abs(pct) >= T.followPriceMovePct) reasons.push(`price ${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(0)}% since the last message`);
    }
    if (!reasons.length && now - c.lastSentAt >= T.followEveryHours * HOUR) reasons.push('⭐ daily check-in');
    if (reasons.length && now - c.lastSentAt < T.minGapHours * HOUR && !reasons.some((r) => /BUY ZONE/.test(r))) return { kind: null, reasons };
  }
  return reasons.length ? { kind: 'update', reasons } : { kind: null, reasons };
}

// the coin still qualifies — remember that (it isn't "forgotten" while it keeps showing up)
export function markSeen(called, token, now = Date.now()) {
  const c = called[token];
  if (c) {
    c.lastSeenAt = now;
    c.miss = 0;
  }
}

export function markSent(called, { token, symbol, tier, score, price }, now = Date.now()) {
  const c = (called[token] ||= { symbol, firstAt: now, firstPrice: price, milestones: {} });
  Object.assign(c, { symbol, lastSentAt: now, lastSeenAt: now, lastScore: score, lastTier: tier, lastPrice: price, miss: 0, active: true });
  if (tier === 'buy') c.buyNotified = true;
  c.firstPrice ??= price;
  return c;
}

// A called coin that stopped qualifying: one note after it misses 2 runs in a row
export function noteMiss(called, prefs, token, reasonText, now = Date.now()) {
  const c = called[token];
  if (!c || !c.active || prefs[token] !== 'follow') return null; // only ⭐ followed coins get "no longer qualifies" notes
  if (now - c.lastSentAt > CONFIG.tracking.forgetDays * DAY) return null;
  c.miss = (c.miss || 0) + 1;
  if (c.miss < 2) return null;
  c.active = false;
  return reasonText;
}

// Milestones from the scorecard (measured from the first call): 2x, 3x, −50%
export function milestones(called, prefs, scorecard) {
  const out = [];
  for (const [token, c] of Object.entries(called)) {
    if (prefs[token] === 'mute') continue;
    const e = scorecard.find((x) => x.token === token);
    if (!e) continue;
    c.milestones ||= {};
    if (e.peakX >= 2 && !c.milestones.x2) out.push({ token, c, e, what: 'x2' });
    if ((e.outcome === 'win' || e.peakX >= 3) && !c.milestones.x3) out.push({ token, c, e, what: 'x3' });
    if ((e.outcome === 'stopped' || e.lowX <= 0.5) && !c.milestones.half) out.push({ token, c, e, what: 'half' });
  }
  for (const m of out) m.c.milestones[m.what] = Date.now();
  return out;
}

// forget coins that went quiet for good
export function pruneCalled(called, now = Date.now()) {
  for (const [t, c] of Object.entries(called)) if (now - c.lastSentAt > 60 * DAY) delete called[t];
}
