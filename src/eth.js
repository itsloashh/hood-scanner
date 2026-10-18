// ETHEREUM CONTEXT — Robinhood Chain is an Ethereum L2 and most memecoins trade against WETH,
// so a coin's USD price moves with ETH. This module:
//   1. reads ETH's price for free from the WETH-paired pools every scan already loads,
//   2. keeps our own ETH price history (state.ethHistory) for 6h / 24h / 7d trends,
//   3. separates a coin's OWN move from ETH's move (so ETH pumping doesn't look like ignition).
const HOUR = 3_600_000;

export function ethPriceFrom(pools) {
  const px = pools
    .filter((p) => /^w?eth$/i.test(p.quoteToken?.symbol || '') && p.quotePriceUsd > 0)
    .map((p) => p.quotePriceUsd)
    .sort((a, b) => a - b);
  return px.length ? px[Math.floor(px.length / 2)] : null; // median: one bad pool can't move it
}

export function recordEth(state, price, now = Date.now()) {
  state.ethHistory ||= [];
  const last = state.ethHistory.at(-1);
  if (price && (!last || now - last[0] >= 30 * 60_000)) state.ethHistory.push([now, Math.round(price * 100) / 100]);
  state.ethHistory = state.ethHistory.filter(([t]) => now - t <= 10 * 24 * HOUR);
}

// % change of ETH over the last `hours`, from our own samples (null until we have that much history)
export function ethChange(state, priceNow, hours, now = Date.now()) {
  const hist = state.ethHistory || [];
  const target = now - hours * HOUR;
  let ref = null;
  for (const [t, p] of hist) if (t <= target + 20 * 60_000) ref = p;
  if (!ref || !priceNow) return null;
  return (priceNow / ref - 1) * 100;
}

export function ethContext(state, priceNow, now = Date.now()) {
  const c = { price: priceNow, h6: ethChange(state, priceNow, 6, now), h24: ethChange(state, priceNow, 24, now), d7: ethChange(state, priceNow, 168, now) };
  const d = c.d7 ?? c.h24;
  c.trend = d == null ? 'unknown' : d >= 8 ? 'strong' : d <= -8 ? 'weak' : 'flat';
  return c;
}

export const isEthPaired = (pool) => /^w?eth$/i.test(pool?.quoteToken?.symbol || '');

// A WETH-paired coin's move with ETH's move taken out. +30% while ETH did +20% → about +8% of its own.
export function ownMove(pool, coinChangePct, ethChangePct) {
  if (coinChangePct == null) return null;
  if (!isEthPaired(pool) || ethChangePct == null) return coinChangePct;
  return ((1 + coinChangePct / 100) / (1 + ethChangePct / 100) - 1) * 100;
}
