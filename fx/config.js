// ─────────────────────────────────────────────────────────────
//  FX DESK — XAU/USD + CAD/JPY context alerts (not trade signals).
//  Every tunable lives here. Free, keyless sources only.
// ─────────────────────────────────────────────────────────────
export const FX = {
  timezone: 'America/Toronto',

  // What we watch. `yahoo` = Yahoo Finance chart symbol (free, keyless).
  pairs: {
    XAUUSD: {
      name: 'Gold (XAU/USD)', yahoo: null, // Yahoo has no spot-gold chart…
      futures: 'GC=F', // …so COMEX futures candles are shifted onto the live spot price (≈ TradingView OANDA:XAUUSD)
      spot: ['XAU', 'USD'], // live spot quote (Swissquote, gold-api.com backup)
      decimals: 1, pip: 0.1,
      currencies: ['USD'], // calendar events that move it
      // how each driver usually pushes it: +1 = driver up → pair up, −1 = driver up → pair down
      drivers: { DXY: -1, US10Y: -1, SPX: 0, OIL: 0, NIKKEI: 0, VIX: +1, USDJPY: 0 },
      macro: { REAL10Y: -1, US2Y: -1 }, // higher real yields / Fed expectations usually weigh on gold
      news: ['gold price', 'XAU USD', 'Federal Reserve rate', 'US dollar index', 'central bank gold buying', 'Treasury yields'],
      cot: 'GOLD - COMMODITY EXCHANGE INC.',
    },
    CADJPY: {
      name: 'CAD/JPY', yahoo: 'CADJPY=X', spot: ['CAD', 'JPY'], decimals: 3, pip: 0.01,
      currencies: ['CAD', 'JPY'],
      drivers: { OIL: +1, SPX: +1, NIKKEI: +1, US10Y: +1, VIX: -1, DXY: 0, USDJPY: +1 },
      macro: {},
      news: ['Canadian dollar', 'Japanese yen', 'Bank of Japan', 'Bank of Canada', 'yen intervention', 'crude oil price'],
      cot: ['CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE', 'JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE'],
    },
  },

  // Cross-market drivers (Yahoo symbols)
  drivers: {
    DXY: { name: 'US Dollar Index', yahoo: 'DX-Y.NYB', shockPct: 0.6 },
    US10Y: { name: 'US 10-year yield', yahoo: '^TNX', shockPct: 2.5 }, // ^TNX is yield×10, so % change works
    OIL: { name: 'WTI crude oil', yahoo: 'CL=F', shockPct: 3 },
    SPX: { name: 'S&P 500 futures', yahoo: 'ES=F', shockPct: 1.5 },
    NIKKEI: { name: 'Nikkei 225', yahoo: '^N225', shockPct: 2 },
    VIX: { name: 'VIX (fear gauge)', yahoo: '^VIX', shockPct: 15 },
    USDJPY: { name: 'USD/JPY (yen strength)', yahoo: 'JPY=X', shockPct: 1 }, // falling = yen strengthening
  },

  // Daily US rates from FRED (keyless CSV). Changes measured in basis points (0.01%).
  macro: {
    REAL10Y: { name: 'US 10-yr real yield', fred: 'DFII10', shockBp: 8 },
    US2Y: { name: 'US 2-yr yield (Fed expectations)', fred: 'DGS2', shockBp: 10 },
  },
  fredUrl: (id) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`,

  // Yen intervention watch: Japan has stepped in when USD/JPY ran up fast. A fast 5-day rise
  // plus official "warning" language in the news = flagged in briefs and alerted once.
  intervention: { fastRisePct: 2.5, words: /intervention|intervene|excessive (moves|volatility)|watching (fx|currency|the market)|rate check|katayama|mimura|ministry of finance|\bmof\b/i },

  // Price sanity check: two spot sources more than this apart = flagged
  priceCheckMaxDiffPct: 0.3,

  // Economic calendar (ForexFactory's public weekly feed)
  calendar: {
    url: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    currencies: ['USD', 'CAD', 'JPY'],
    alertImpact: ['High'], // pre-event alerts
    briefImpact: ['High', 'Medium'], // listed in briefs
    warnMinutes: 30, // heads-up this long before a high-impact release
    speeches: /speaks|testif|press conference|monetary policy statement|policy rate|rate decision|rate statement|minutes|outlook report|summary of opinions/i, // medium-impact too
    resultSearchMinutes: [5, 75], // look for the published number this long after a release
    countryName: { USD: 'US', CAD: 'Canada', JPY: 'Japan' },
    // gold-moving even at medium impact
    goldKeywords: /cpi|pce|non-farm|nfp|fomc|fed|powell|unemployment|gdp|ppi|retail sales|ism/i,
  },

  // News: several sites, matched by keyword, deduped. Google News RSS pulls Reuters, Bloomberg,
  // CNBC, Kitco, FXStreet, MarketWatch… in one free feed.
  feeds: [
    { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', always: true },
    { name: 'Bank of Canada', url: 'https://www.bankofcanada.ca/content_type/press-releases/feed/', always: true },
    { name: 'Bank of Japan', url: 'https://www.boj.or.jp/en/rss/whatsnew.xml', always: true },
  ],
  googleNews: (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:1d&hl=en-US&gl=US&ceid=US:en`,
  // Only these outlets make it into briefs/alerts (Google News also returns local blogs and chart spam).
  // Central-bank feeds are always kept.
  trustedSources: /reuters|bloomberg|cnbc|wall street journal|wsj|financial times|\bft\b|marketwatch|barron|kitco|fxstreet|forexlive|investinglive|dailyfx|investing\.com|yahoo finance|business insider|the economist|associated press|\bap news|nikkei|japan times|globe and mail|bnn|financial post|cbc|axios|fortune|morningstar|seeking alpha|the business times|south china morning post|al jazeera|bbc|guardian|new york times|cnn business|fox business|benzinga|coindesk/i,

  // headlines worth an immediate alert (everything else waits for the brief)
  breaking: /intervention|emergency|surprise|unexpected|rate (hike|cut)|hikes rates|cuts rates|holds rates|war|missile|invasion|sanction|tariff|default|downgrade|shutdown|resign|ceasefire|record high|all-time high|plunge|crash|soar|tumble/i,
  maxHeadlineAlertsPerRun: 3,
  confirmOutlets: 2, // a breaking headline alerts only when this many trusted outlets carry the story (central banks: 1)

  // CFTC Commitments of Traders (weekly, keyless JSON) — big-speculator positioning
  cotUrl: (market) => `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=market_and_exchange_names='${encodeURIComponent(market)}'&$order=report_date_as_yyyy_mm_dd DESC&$limit=8`,

  // Structure / move alerts
  structure: {
    swingLookback: 3, // a swing high/low needs 3 lower/higher bars each side
    atrPeriod: 14,
    bigMoveAtr: 1.0, // a 1-ATR day move (hourly view) = notable
    levelCooldownHours: 8, // same level-break alert at most every 8h
  },

  schedule: {
    briefLocal: '06:45', // weekdays, before the 7:30 stream
    weeklyLocal: '18:00', // Sunday outlook, right as FX opens
  },
};
