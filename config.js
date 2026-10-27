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
  holderCacheMin: 120,
  // Holder lists (top wallets) are slow on Blockscout, so a separate job fetches them with
  // long timeouts and writes data/holders.json; scans just read it.
  holdersJob: { maxCoins: 30, freshHours: 6, timeoutSec: 75, budgetMin: 11, scanFallback: false }, // scanFallback: let the scan call Blockscout itself // re-use a coin's holder data for 2h — keeps Blockscout well inside the free 100k credits/day
  dexpaprika: { base: 'https://api.dexpaprika.com', network: 'robinhood', minIntervalMs: 4200 }, // keyless ≈ 15 calls/min
  infoCacheMin: 120, // token info (socials, holder count, GT score) re-used for 2h
  chartCacheMin: 60, // daily candles re-used for 1h (today's candle comes from the live pool price)
  geckoMinIntervalMs: 2200, // keyless GeckoTerminal ≈ 30 calls/min — stay under it
  blockscoutMinIntervalMs: 300,

  // How wide each scan casts the net
  scan: {
    sorts: ['h24_volume_usd_desc', 'h24_tx_count_desc'],
    pagesPerSort: 10, // 20 pools per page (10 is the free max)
    // The two sorts overlap heavily, and established coins are also re-checked via the
    // watchlist + holder-count universe — so fewer pages, fewer GeckoTerminal 429s
    pagesBySort: { h24_volume_usd_desc: 7, h24_tx_count_desc: 3 },
    includeTrending: true,
    maxDeepChecks: 25, // candidates that get the full holder/chart check per run
    maxPumpChecks: 6, // pumping coins analysed for a pullback entry per run
    watchlistMax: 120, // coins that once passed the quick filter get re-checked every run, even if they drop off the top lists
    // Discovery by holder count (Blockscout) — finds established coins too quiet for the volume lists
    discoverEveryMin: 120,
    discoverPages: 10, // 50 tokens per page → top 500 tokens by holder count
    universeMax: 240,
    timeBudgetMin: 8, // stop starting new checks after 8 min so the run always saves (GitHub kills it at 12)
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
  // Two lanes (from the CASHCAT / FRONG / PONS / DIH / 🪶 case study):
  //   MICRO   $5k–$333k  — survivors bouncing off the floor. Small size only; holder counts are often padded.
  //   QUALITY $333k–$25M — established coins with real crowds setting up a second leg (FRONG ran 5.4× from $3.6M).
  maxMarketCap: 25_000_000, // overall ceiling (top of the quality lane)
  minMarketCap: 5_000, // DIH's 7.3× second leg started at $8k
  minLiquidityUsd: 3_000, // micro-lane floor
  lanes: {
    microMaxMarketCap: 333_000, // Logan's original ceiling = the micro lane
    quality: {
      minHolders: 5_000,
      minUsdPerHolder: 10, // market cap ÷ holders — below this the holder count is padded with dust wallets
      minLiquidityUsd: 100_000,
      minDrawdownPct: 50, // the second legs started 73–79% off their highs
      maxDrawdownPct: 90,
    },
  },

  // Quiet base: price going sideways while volume dries up — every second leg in the
  // case study started from this (volume trend 0.37–0.79×, 7-day range 1.2–2×)
  quietBase: { maxVolTrend: 0.8, maxBaseRange: 2, minDrawdownPct: 50, maxDrawdownPct: 97 },
  // Absorption base: the opposite volume picture with the same flat price — volume keeps coming
  // in (≥1.2×) yet price won't drop: weak sellers are being soaked up by steady buyers.
  // FLORK's 19× second leg came from this (volume 1.81×, 7-day range 1.38×, 89% off its high).
  absorption: { minVolTrend: 1.2, maxBaseRange: 1.6, maxWeekMovePct: 30, minDrawdownPct: 50, maxDrawdownPct: 97, maxSellerRatio: 1.5 },

  // 🔥 IGNITION: hourly volume explodes out of a quiet base (FRONG went 5.4× within a day of it)
  ignition: {
    maxChecks: 15, // quiet-base coins whose hourly candles get checked each run
    hours: 3, // look at the last 3 hourly candles…
    minVolMultiple: 5, // …trading at ≥5× the base's normal hourly volume
    maxPriceAboveBasePct: 40, // still early: price no more than 40% above the base's top
    minVolume24hUsd: 5_000, // ignore 'ignition' from a handful of tiny trades
    cooldownHours: 72, // at most one ignition alert per coin every 3 days
    keepDays: 7, // forget a quiet base not re-confirmed for a week
  },

  // Catalysts: outside buyers arriving (Robinhood app listing, Binance Wallet, big follows) and buybacks
  catalyst: {
    manualBonus: 6, // you tag it from Telegram: /catalyst 0x… listing
    manualDays: 14, // a tag counts for 2 weeks
    buybackMinBurns: 3, // 3+ burns in the last week = a buyback machine, not a one-off
    buybackBonus: 2,
    identityBonus: 2, // coin is part of the chain's identity (launchpad token, Robinhood-themed)
    identityPattern: /robin|hood|tenev|vlad|launchpad|\bpons\b/i,
    max: 8,
  },

  // Copycats: a different contract using the ticker of an established coin (ticker search kept finding fake PONS/FRONG)
  knownCoins: {
    CASHCAT: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
    PONS: '0x39dbed3a2bd333467115de45665cc57f813c4571',
    FRONG: '0x6245e67affa44a23077f0ea7f981a8dc743a0c47',
    FLORK: '0x46544163f545a8e306e2671528ffc1b0ef8fe8cf', // Robinhood Chain FLORK (not the BNB one)
  },
  copycatMinHolders: 5_000, // any ticker held by 5k+ wallets is "established" and protected

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
    roundTripRetrace: 0.85, // if the typical pump gives back ≥85% of its move, say so: it's a fade, not a dip-buy
    cooldownHours: 24,
  },

  // Target band: we want 3x–10x, not lottery tickets
  targetMinX: 3,
  targetMaxX: 10,

  // ── Scoring / alerting ───────────────────────────────────
  // Winner profile (src/profile.js) — micro-lane calls must look like our past 2× winners.
  // Oct 17–27: coins we called by score alone doubled 5% of the time; coins matching this did 27–75%.
  // Quality lane not gated yet: no snapshot data for $1M+ coins until now.
  profile: { enabled: true, lanes: ['micro'], minBuyers24h: 60, minBuySell: 1.0, minVolRatio: 2, change24h: [0, 60] },

  alertScore: 65, // 🟢 BUY ZONE — opens a paper position
  watchScore: 50, // 👀 WATCH — heads-up only, no paper position
  regimeAdjust: { riskOn: -5, riskOff: +10 },
  // Called coins: one full alert, then short updates only when something changes (src/tracking.js)
  tracking: {
    // normal coins: after the first alert, only the first move into the buy zone + 2×/3×/−50% milestones
    followScoreJump: 10, followPriceMovePct: 25, followEveryHours: 24, // ⭐ followed coins also get these + a daily check-in
    minGapHours: 2, // never two updates on the same coin within 2h (except a move up to buy zone)
    forgetDays: 14, // silent for 14 days → a fresh full alert if it qualifies again
  },
  realertCooldownHours: 72, // don't re-alert the same coin unless the score jumps…
  realertScoreJump: 10,
  watchCooldownHours: 24,

  // ── Paper trading: the $30 test ──────────────────────────
  paper: {
    enabled: true,
    auto: false, // paper trades are placed by you from Telegram (/paper). true = old auto-trading
    startingBankroll: 30, // just a test number — the real paper wallet lives in Telegram (/paper → Wallet → reset to any amount)
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
  // Every alert is tracked for 30 days: did it reach 3x before falling 50%?
  scorecard: { winX: 3, stopX: 0.5, days: 30, maxEntries: 400 },
  // On alerts, DexPaprika's price is compared with GeckoTerminal's; disagreement = warning
  priceCheckMaxDiffPct: 10,

  digestEveryHours: 4,
  digestHourLocal: 9, // (legacy — no longer used)
  timezone: 'America/Toronto',

  // Snapshot logger — builds the research dataset
  snapshotMaxMarketCap: 25_000_000, // log quality-lane coins too, so they can be studied

  // Base tokens that are never memecoins
  ignoreSymbols: ['WETH', 'ETH', 'USDC', 'USDT', 'USDG', 'DAI', 'WBTC', 'CBBTC'],
};
