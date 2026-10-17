// ─────────────────────────────────────────────────────────────
//  HOOD SCANNER — every tunable parameter lives in this file.
//  Change a number here, push, and the next run uses it.
// ─────────────────────────────────────────────────────────────

export const CONFIG = {
  // Data sources (free, no API keys)
  network: process.env.GT_NETWORK || 'robinhood', // GeckoTerminal network id for Robinhood Chain
  geckoBase: 'https://api.geckoterminal.com/api/v2',
  blockscoutBase: 'https://robinhoodchain.blockscout.com/api/v2',
  geckoMinIntervalMs: 2200, // keyless GeckoTerminal ≈ 30 calls/min — stay under it
  blockscoutMinIntervalMs: 300,

  // How wide each scan casts the net
  scan: {
    sorts: ['h24_volume_usd_desc', 'h24_tx_count_desc'],
    pagesPerSort: 10, // 20 pools per page
    maxDeepChecks: 25, // candidates that get the full holder/chart check per run
  },

  // ── Logan's core parameters ──────────────────────────────
  minAgeDays: 21, // "coins over 3 weeks old"
  maxMarketCap: 333_000, // "under $333,000 market cap"
  minMarketCap: 15_000, // below this it's usually dead, not early
  minLiquidityUsd: 5_000, // need enough depth to get in and out

  // "Established community"
  community: {
    minHolders: 250,
    minBuyers24h: 15, // unique buyers, so one wallet can't fake activity
    minSellers24h: 3, // people CAN sell → honeypot proxy
    requireSocial: true, // at least one of X / Telegram / website
  },

  // "Not locked up in a majority's wallet"
  // Measured on real wallets only: LP pools, launchpad contracts and burn addresses are excluded.
  distribution: {
    maxTop1Pct: 8,
    maxTop10Pct: 35,
    maxDevPct: 5,
  },

  // Skip coins already mid-pump — we want bases, not tops
  maxChange24hPct: 100,

  // ── Scoring / alerting ───────────────────────────────────
  alertScore: 65, // 0–100; raised automatically in a cold market
  regimeAdjust: { riskOn: -5, riskOff: +10 },
  realertCooldownHours: 72, // don't re-alert the same coin unless the score jumps
  realertScoreJump: 10,

  // ── Paper trading: the $30 test ──────────────────────────
  paper: {
    enabled: true,
    startingBankroll: 30,
    positionFraction: 1 / 3, // $10 slices to start
    minPositionUsd: 2,
    maxOpen: 3,
    stopLossPct: -50,
    takeProfits: [
      { x: 3, sell: 0.5 }, // at 3x sell half (principal back + profit)
      { x: 5, sell: 0.25 }, // at 5x sell another quarter
    ],
    runnerTargetX: 10, // close the rest at 10x
    trailFromPeakPct: 40, // after TP1, close the runner if it drops 40% from its peak
    maxHoldDays: 30,
    slippagePct: 3, // per side, assumed
  },

  // Daily summary message (Toronto time)
  digestHourLocal: 9,
  timezone: 'America/Toronto',

  // Snapshot logger — builds the research dataset every run
  snapshotMaxMarketCap: 1_000_000,

  // Base tokens that are never memecoins
  ignoreSymbols: ['WETH', 'ETH', 'USDC', 'USDT', 'USDG', 'DAI', 'WBTC', 'CBBTC'],
};
