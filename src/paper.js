// Paper trading — the $30 test. Every alert opens a simulated position with
// the plan attached; each run marks it to market and applies the exit rules.
import { CONFIG } from '../config.js';

const DAY = 86_400_000;

export function newPaperState() {
  return { cash: CONFIG.paper.startingBankroll, positions: [], closed: [], startedAt: Date.now() };
}

export function equity(paper, prices = {}) {
  let open = 0;
  for (const p of paper.positions) {
    const px = prices[p.token]?.price ?? p.lastPrice ?? p.entryPrice;
    open += p.sizeUsd * p.remaining * (px / p.entryPrice);
  }
  return paper.cash + open;
}

export function planFor(price) {
  const c = CONFIG.paper;
  return {
    entry: price,
    stop: price * (1 + c.stopLossPct / 100),
    takeProfits: c.takeProfits.map((tp) => ({ ...tp, price: price * tp.x })),
    runner: price * c.runnerTargetX,
  };
}

export function openPosition(paper, { token, symbol, pool, price, score }, now = Date.now()) {
  const c = CONFIG.paper;
  if (!c.enabled || !price) return null;
  if (paper.positions.length >= c.maxOpen) return null;
  if (paper.positions.some((p) => p.token === token)) return null;
  const size = Math.min(paper.cash, equity(paper) * c.positionFraction);
  if (size < c.minPositionUsd) return null;
  const entryPrice = price * (1 + c.slippagePct / 100);
  const pos = {
    token, symbol, pool, score,
    entryPrice, sizeUsd: size, remaining: 1, peak: entryPrice, lastPrice: price,
    tpHit: c.takeProfits.map(() => false), realized: 0, openedAt: now, misses: 0,
  };
  paper.cash -= size;
  paper.positions.push(pos);
  return pos;
}

// prices: { [token]: { price, liquidityUsd } }
export function updatePositions(paper, prices, now = Date.now()) {
  const c = CONFIG.paper;
  const slipOut = 1 - c.slippagePct / 100;
  const events = [];

  const sell = (pos, fraction, price, why) => {
    const proceeds = pos.sizeUsd * fraction * (price / pos.entryPrice) * slipOut;
    pos.remaining = Math.max(0, pos.remaining - fraction);
    pos.realized += proceeds;
    paper.cash += proceeds;
    events.push({ type: 'sell', pos, fraction, price, why, proceeds });
  };

  for (const pos of [...paper.positions]) {
    const q = prices[pos.token];
    let price = q?.price;

    if (!price) {
      pos.misses += 1;
      if (pos.misses >= 6) sell(pos, pos.remaining, 0, 'pool vanished — counted as total loss');
    } else {
      pos.misses = 0;
      pos.lastPrice = price;
      if ((q.liquidityUsd ?? Infinity) < 500) {
        sell(pos, pos.remaining, price * 0.1, 'liquidity pulled (rug) — near total loss');
      } else {
        pos.peak = Math.max(pos.peak, price);
        const x = price / pos.entryPrice;

        if (x <= 1 + c.stopLossPct / 100) {
          sell(pos, pos.remaining, price, `stop loss (${c.stopLossPct}%)`);
        } else {
          c.takeProfits.forEach((tp, i) => {
            if (!pos.tpHit[i] && x >= tp.x && pos.remaining > 0) {
              pos.tpHit[i] = true;
              sell(pos, Math.min(tp.sell, pos.remaining), price, `take profit ${tp.x}x`);
            }
          });
          if (pos.remaining > 0 && x >= c.runnerTargetX) {
            sell(pos, pos.remaining, price, `runner target ${c.runnerTargetX}x`);
          } else if (pos.remaining > 0 && pos.tpHit[0] && price <= pos.peak * (1 - c.trailFromPeakPct / 100)) {
            sell(pos, pos.remaining, price, `trailing stop (−${c.trailFromPeakPct}% from peak)`);
          } else if (pos.remaining > 0 && now - pos.openedAt >= c.maxHoldDays * DAY) {
            sell(pos, pos.remaining, price, `time stop (${c.maxHoldDays}d)`);
          }
        }
      }
    }

    if (pos.remaining <= 1e-9) {
      paper.positions = paper.positions.filter((p) => p !== pos);
      const pnl = pos.realized - pos.sizeUsd;
      const record = {
        token: pos.token, symbol: pos.symbol, score: pos.score,
        openedAt: pos.openedAt, closedAt: now, sizeUsd: pos.sizeUsd, realized: pos.realized,
        pnl, multiple: pos.realized / pos.sizeUsd,
        hit3x: pos.tpHit[0],
      };
      paper.closed.push(record);
      events.push({ type: 'closed', pos, record });
    }
  }
  return events;
}

export function stats(paper) {
  const n = paper.closed.length;
  const wins = paper.closed.filter((t) => t.pnl > 0).length;
  const hit3x = paper.closed.filter((t) => t.hit3x).length;
  const avgMultiple = n ? paper.closed.reduce((s, t) => s + t.multiple, 0) / n : null;
  return { trades: n, wins, winRate: n ? wins / n : null, hit3x, avgMultiple };
}
