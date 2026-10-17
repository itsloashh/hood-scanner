// ─────────────────────────────────────────────────────────────
//  HOOD SCANNER — every tunable parameter lives in this file.
//  Change a number here, push, and the next run uses it.
// ─────────────────────────────────────────────────────────────

export const CONFIG = {
  // Data sources (free, no API keys)
  network: process.env.GT_NETWORK || 'robinhood', // GeckoTerminal network id for Robinhood Chain
  geckoBase: 'https://api.geckoterminal.com/api/v2',
  blockscoutBase: 'https://robinhoodchain.blockscout.com/api/v2', // public explorer (used when no key)
  blockscoutProBase: 'https://api.blockscout.com', // PRO API (used when BLOCKSCOUT_API_KEY is set)
  chainId: 4663, // Robinhood Chain
  holderCacheMin: 120, // re-use a coin's holder data for 2h — keeps Blockscout well inside the free 100k credits/day
  geckoMinIntervalMs: 2200, // keyless GeckoTerminal ≈ 30 calls/min — stay under it
  blockscoutMinIntervalMs: 300,

  // How wide each scan casts the net
  scan: {
    sorts: ['h24_volume_usd_desc', 'h24_tx_count_desc'],
    pagesPerSort: 10, // 20 pools per page (10 is the free max)
    includeTrending: true,
    maxDeepChecks: 25, // candidates that get the full holder/chart check per run
    maxPumpChecks: 6, // pumping coins analysed for a pullback entry per run
    watchlistMax: 120, // coins that once passed the quick filter get re-checked every run, even if they drop off the top lists
    // Discovery by holder count (Blockscout) — finds established coins too quiet for the volume lists
    discoverEveryMin: 120,
    discoverPages: 6, // 50 tokens per page
    universeMax: 240,
  },

  // Not memecoins: Robinhood Stock Tokens and other wrapped/real-world assets
  excludeNamePattern: /stock token|tokenized|xstock|\betf\b|\binc\.?$|corporation|holdings|treasury|wrapped|bridged|usd coin|tether/i,

  minMinutesBetweenScheduledScans: 10, // GitHub's backup schedule skips if a scan just ran

  // Runs every 15 min. These keep the dataset and history at sensible spacing.
  cadence: {
    snapshotEveryMin: 60, // research CSV row per coin
    holderSampleEveryMin: 120, // holder-count history (conviction signal)
    regimeSampleEveryMin: 120, // chain-wide volume history (market regime)
  },

  // ── Logan's core parameters ──────────────────────────────
  minAgeDays: 21, // "coins over 3 weeks old"
  maxMarketCap: 333_000, // "under $333,000 market cap"
  minMarketCap: 10_000, // below this it's usually dead, not early
  minLiquidityUsd: 3_000, // need enough depth to get in and out of a $10 position

  // "Established community"
  community: {
    minHolders: 150,
    minBuyers24h: 8, // unique buyers, so one wallet can't fake activity
    minSellers24h: 2, // people CAN sell → honeypot proxy
    requireSocial: true, // at least one of X / Telegram / website / Discord
    maxSusReports: 2, // GeckoTerminal community "suspicious" reports; more than this = reject
    maxSharedXHandle: 1, // same X handle linked to another token = copycat warning
  },

  // "Not locked up in a majority's wallet"
  // Measured on real wallets only: LP pools, launchpad contracts and burn addresses are excluded.
  distribution: {
    maxTop1Pct: 8,
    maxTop10Pct: 40,
    maxDevPct: 5,
  },

  // Coins up this much in 24h aren't bases — they go to the PUMP path instead:
  // pullback odds + a limit-buy entry zone (see src/pump.js)
  maxChange24hPct: 50,
  pump: {
    minChangePct: 50, // +50% in 24h = "pumping"
    minExamples: 5, // past pumps needed before we trust chain stats (else Fibonacci 38–62% fallback)
    stopBelowBasePct: 3, // stop just under where the pump started
    cooldownHours: 24,
  },

  // Target band: we want 3x–10x, not lottery tickets
  targetMinX: 3,
  targetMaxX: 10,

  // ── Scoring / alerting ───────────────────────────────────
  alertScore: 65, // 🟢 BUY ZONE — opens a paper position
  watchScore: 50, // 👀 WATCH — heads-up only, no paper position
  regimeAdjust: { riskOn: -5, riskOff: +10 },
  realertCooldownHours: 72, // don't re-alert the same coin unless the score jumps…
  realertScoreJump: 10,
  watchCooldownHours: 24,

  // ── Paper trading: the $30 test ──────────────────────────
  paper: {
    enabled: true,
    auto: false, // paper trades are placed by you from Telegram (/paper). true = old auto-trading
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

  // ── Burns / deflation ────────────────────────────────────
  // Supply sent to burn addresses (0x…dead / 0x0). Bonus up to +5:
  //   +2 if ≥20% of supply is burned (+3 if ≥50%) · +2 if burns happened in the last 7 days
  burns: { cacheHours: 6, recentDays: 7, bigBurnPct: 20, hugeBurnPct: 50 },

  // ── Wallet intelligence ───────────────────────────────────
  // Every run pulls the last 24h of trades (free, GeckoTerminal) for coins that pass
  // the junk filter, records who bought, and later checks whether those buys won.
  wallets: {
    tradesPerRunMaxPools: 12, // pools whose trades get pulled each run
    tradeRefreshMin: 60, // re-pull a pool's trades at most hourly
    whaleBuyUsd: 500,
    bundleMinWallets: 3, // ≥3 different wallets buying in the same block = likely bundle/bot cluster
    winMultiple: 3, // a buy "wins" if price hits 3x within…
    winWindowDays: 30,
    lossDrawdownPct: -60, // …and "loses" if it falls 60% first (or the window ends)
    smartMinWins: 2, // smart wallet = at least 2 wins…
    smartMinHitRate: 0.4, // …and ≥40% of its resolved buys won
    sprayMaxTokensPerDay: 15, // wallets buying more distinct tokens than this per day are treated as bots
    maxWallets: 6000, // cap file size
    smartBonusPerWallet: 4, // score bonus per smart wallet buying in last 24h…
    smartBonusMax: 10, // …up to this many points
  },

  // Summary message every N hours, around the clock. Alerts themselves go out any time.
  digestEveryHours: 4,
  digestHourLocal: 9, // (legacy — no longer used)
  timezone: 'America/Toronto',

  // Snapshot logger — builds the research dataset
  snapshotMaxMarketCap: 1_000_000,

  // Base tokens that are never memecoins
  ignoreSymbols: ['WETH', 'ETH', 'USDC', 'USDT', 'USDG', 'DAI', 'WBTC', 'CBBTC'],
};
