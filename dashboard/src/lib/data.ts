// Reads the scanner's own data files straight from the GitHub repo the bot commits to.
// Nothing new to run: every scan commit is picked up within a couple of minutes.

const REPO = process.env.SCANNER_REPO || 'itsloashh/hood-scanner';
const BRANCH = process.env.SCANNER_BRANCH || 'main';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/data`;

export const REVALIDATE_SEC = 120;

async function getJson<T>(path: string, fallback: T, revalidate = REVALIDATE_SEC): Promise<T> {
  try {
    const res = await fetch(`${RAW}/${path}`, { next: { revalidate, tags: ['scanner'] } });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

// ── Raw shapes (only the fields the dashboard uses) ──────────────
export type ScoreEntry = {
  token: string;
  symbol: string;
  tier: 'buy' | 'watch' | 'ignition' | 'pump';
  lane?: 'micro' | 'quality';
  kind?: 'meme' | 'utility' | null;
  ethTrend?: string;
  score?: number;
  at: number;
  price: number;
  mcap?: number | null;
  pool?: string;
  peakX?: number;
  lowX?: number;
  lastX?: number;
  outcome?: 'win' | 'stopped' | 'expired' | null;
  closedAt?: number;
};

export type CalledCoin = {
  symbol: string;
  firstAt: number;
  firstPrice: number;
  lastSentAt?: number;
  lastScore?: number;
  lastTier?: string;
  lastPrice?: number;
  active?: boolean;
  milestones?: Record<string, number>;
  buyNotified?: boolean;
  lastSeenAt?: number;
};

export type RunStats = {
  at: string;
  scanned: number;
  quickPass: number;
  deepPass: number;
  buy: number;
  watch: number;
  pump: number;
  ignition: number;
  quality: number;
  micro: number;
  profileMiss?: number;
  regime: string;
  universe: number;
  watchlist: number;
  topCuts?: Record<string, number>;
  http?: Record<string, { calls: number; sec: number; waitSec?: number; backoffSec?: number; r429?: number; fails?: number }>;
  phases?: Record<string, number>;
};

export type ScannerState = {
  scorecard: ScoreEntry[];
  called: Record<string, CalledCoin>;
  ignitionAlerts: Record<string, { at: number; symbol: string }>;
  pumpAlerts: Record<string, { at: number; symbol: string }>;
  watchAlerts: Record<string, { at: number; score: number; symbol: string }>;
  alerts: Record<string, { at: number; score: number; symbol: string }>;
  lastRun?: RunStats;
  runs?: number;
  funnel24h?: { t: number; scanned: number; quickPass: number; deepPass: number; reasons?: Record<string, number> }[];
  volumeHistory?: { t: number; v: number }[];
  ethHistory?: [number, number][];
  eth?: { price: number; h6?: number; h24?: number; d7?: number; trend?: string };
  watchlist?: Record<string, { symbol: string; at: number }>;
  quietBases?: Record<string, unknown>;
  paper?: { cash: number; positions: unknown[] };
};

export type Prices = { at: string; p: Record<string, [number, number, number, string]> };
export type Prefs = { coins: Record<string, 'follow' | 'mute'> };

const EMPTY_STATE: ScannerState = {
  scorecard: [],
  called: {},
  ignitionAlerts: {},
  pumpAlerts: {},
  watchAlerts: {},
  alerts: {},
};

export async function loadAll() {
  const [state, prices, prefs] = await Promise.all([
    getJson<ScannerState>('state.json', EMPTY_STATE),
    getJson<Prices>('prices.json', { at: '', p: {} }),
    getJson<Prefs>('coin-prefs.json', { coins: {} }),
  ]);
  return { state: { ...EMPTY_STATE, ...state }, prices, prefs };
}

// Hourly candles for one pool (GeckoTerminal, free). Cached 15 min so we stay well under rate limits.
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export async function poolCandles(pool: string, sinceMs: number): Promise<Candle[]> {
  const days = Math.max(1, (Date.now() - sinceMs) / 86_400_000);
  // ≤ 1000 candles: hourly up to ~40 days, then 4-hourly
  const agg = days > 40 ? 4 : 1;
  const limit = Math.min(1000, Math.ceil((days * 24) / agg) + 48 / agg);
  const url = `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pool}/ohlcv/hour?aggregate=${agg}&limit=${limit}&currency=usd`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, next: { revalidate: 900 } });
    if (!res.ok) return [];
    const j = await res.json();
    const list: number[][] = j?.data?.attributes?.ohlcv_list ?? [];
    return list
      .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o, h, l, c, v }))
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}
