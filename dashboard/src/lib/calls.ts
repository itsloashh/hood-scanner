// Turns the bot's scorecard (one row per alert) into one "call" per coin with its full timeline.
import type { CalledCoin, Prefs, Prices, ScannerState, ScoreEntry } from './data';

export type Tier = ScoreEntry['tier'];
export type Status = 'win' | 'stopped' | 'expired' | 'open';

export type CallEvent = { tier: Tier; at: number; price: number; score?: number; peakX?: number; lowX?: number; outcome?: string | null };

export type Call = {
  token: string;
  symbol: string;
  lane: 'micro' | 'quality' | 'unknown';
  kind: 'meme' | 'utility' | 'unknown';
  firstTier: Tier;
  firstAt: number;
  firstPrice: number;
  mcapAtCall: number | null;
  score: number | null;
  bestScore: number | null;
  ethTrend: string | null;
  pool: string | null;
  watchAt: number | null;
  buyAt: number | null;
  ignitionAt: number | null;
  pumpAt: number | null;
  events: CallEvent[];
  peakX: number; // best price since first call ÷ first call price
  lowX: number;
  lastX: number;
  nowPrice: number | null;
  nowX: number | null;
  nowMcap: number | null;
  nowLiq: number | null;
  status: Status;
  closedAt: number | null;
  hit2x: boolean;
  hit3x: boolean;
  halved: boolean;
  pref: 'follow' | 'mute' | null;
  milestones: Record<string, number>;
  ageDays: number;
};

const first = <T,>(xs: T[]) => (xs.length ? xs[0] : undefined);

export function buildCalls(state: ScannerState, prices: Prices, prefs: Prefs, now = Date.now()): Call[] {
  const byToken = new Map<string, ScoreEntry[]>();
  for (const e of state.scorecard ?? []) {
    if (!e?.token) continue;
    const list = byToken.get(e.token) ?? [];
    list.push(e);
    byToken.set(e.token, list);
  }
  // Coins the bot told you about that aren't in the scorecard (older than the scorecard itself)
  for (const [token, c] of Object.entries(state.called ?? {})) {
    if (!byToken.has(token) && c.firstPrice) {
      byToken.set(token, [{ token, symbol: c.symbol, tier: (c.lastTier as Tier) || 'watch', at: c.firstAt, price: c.firstPrice }]);
    }
  }

  const calls: Call[] = [];
  for (const [token, rows] of byToken) {
    rows.sort((a, b) => a.at - b.at);
    const f = rows[0];
    const called: CalledCoin | undefined = state.called?.[token];
    const firstAt = Math.min(f.at, called?.firstAt ?? Infinity);
    const firstPrice = called && called.firstAt <= f.at && called.firstPrice ? called.firstPrice : f.price;
    const live = prices.p?.[token];
    const nowPrice = live?.[0] ?? null;
    const at = (t: Tier) => first(rows.filter((r) => r.tier === t))?.at ?? null;

    // Each scorecard row tracks peak/low from its own price; convert all to "× first call price"
    let peakX = 1, lowX = 1, lastX = 1;
    for (const r of rows) {
      const k = r.price / firstPrice;
      if (r.peakX != null) peakX = Math.max(peakX, r.peakX * k);
      if (r.lowX != null) lowX = Math.min(lowX, r.lowX * k);
    }
    const lastRow = rows[rows.length - 1];
    if (lastRow.lastX != null) lastX = (lastRow.lastX * lastRow.price) / firstPrice;
    const nowX = nowPrice ? nowPrice / firstPrice : null;
    if (nowX != null) {
      lastX = nowX;
      peakX = Math.max(peakX, nowX);
      lowX = Math.min(lowX, nowX);
    }

    const outcome = f.outcome ?? null;
    const status: Status = outcome === 'win' ? 'win' : outcome === 'stopped' ? 'stopped' : outcome === 'expired' ? 'expired' : 'open';
    const scores = rows.map((r) => r.score).filter((s): s is number => typeof s === 'number');
    const mcapRow = rows.find((r) => r.mcap);

    calls.push({
      token,
      symbol: f.symbol || called?.symbol || token.slice(0, 6),
      lane: (rows.find((r) => r.lane)?.lane ?? 'unknown') as Call['lane'],
      kind: (rows.find((r) => r.kind)?.kind ?? 'unknown') as Call['kind'],
      firstTier: f.tier,
      firstAt,
      firstPrice,
      mcapAtCall: mcapRow?.mcap ? (mcapRow.mcap * firstPrice) / mcapRow.price : live && nowPrice ? (live[1] * firstPrice) / nowPrice : null,
      score: f.score ?? null,
      bestScore: scores.length ? Math.max(...scores) : null,
      ethTrend: f.ethTrend ?? null,
      pool: rows.find((r) => r.pool)?.pool ?? live?.[3] ?? null,
      watchAt: at('watch') ?? state.watchAlerts?.[token]?.at ?? null,
      buyAt: at('buy') ?? state.alerts?.[token]?.at ?? null,
      ignitionAt: at('ignition') ?? state.ignitionAlerts?.[token]?.at ?? null,
      pumpAt: at('pump') ?? state.pumpAlerts?.[token]?.at ?? null,
      events: rows.map((r) => ({ tier: r.tier, at: r.at, price: r.price, score: r.score, peakX: r.peakX, lowX: r.lowX, outcome: r.outcome })),
      peakX,
      lowX,
      lastX,
      nowPrice,
      nowX,
      nowMcap: live?.[1] || null,
      nowLiq: live?.[2] ?? null,
      status,
      closedAt: f.closedAt ?? null,
      hit2x: peakX >= 2,
      hit3x: peakX >= 3,
      halved: lowX <= 0.5,
      pref: prefs.coins?.[token] ?? null,
      milestones: called?.milestones ?? {},
      ageDays: (now - firstAt) / 86_400_000,
    });
  }
  return calls.sort((a, b) => b.firstAt - a.firstAt);
}

// ── Stats ───────────────────────────────────────────────
export type Group = { key: string; n: number; hit2x: number; win: number; stopped: number; open: number; avgPeak: number; medPeak: number; rate2x: number };

export function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function groupBy(calls: Call[], keyOf: (c: Call) => string, order?: string[]): Group[] {
  const map = new Map<string, Call[]>();
  for (const c of calls) {
    const k = keyOf(c);
    map.set(k, [...(map.get(k) ?? []), c]);
  }
  const groups = [...map.entries()].map(([key, cs]) => ({
    key,
    n: cs.length,
    hit2x: cs.filter((c) => c.hit2x).length,
    win: cs.filter((c) => c.status === 'win').length,
    stopped: cs.filter((c) => c.status === 'stopped').length,
    open: cs.filter((c) => c.status === 'open').length,
    avgPeak: cs.reduce((s, c) => s + c.peakX, 0) / cs.length,
    medPeak: median(cs.map((c) => c.peakX)),
    rate2x: cs.filter((c) => c.hit2x).length / cs.length,
  }));
  if (order) return order.map((k) => groups.find((g) => g.key === k)).filter((g): g is Group => !!g);
  return groups.sort((a, b) => b.n - a.n);
}

export function summary(calls: Call[]) {
  const n = calls.length;
  const hit2x = calls.filter((c) => c.hit2x).length;
  const hit3x = calls.filter((c) => c.hit3x).length;
  const win = calls.filter((c) => c.status === 'win').length;
  const stopped = calls.filter((c) => c.status === 'stopped').length;
  const open = calls.filter((c) => c.status === 'open').length;
  const halved = calls.filter((c) => c.halved).length;
  return {
    n,
    hit2x,
    hit3x,
    win,
    stopped,
    open,
    halved,
    rate2x: n ? hit2x / n : 0,
    medPeak: median(calls.map((c) => c.peakX)),
    best: [...calls].sort((a, b) => b.peakX - a.peakX)[0],
  };
}

export const scoreBucket = (s: number | null) => (s == null ? 'n/a' : s >= 70 ? '70+' : s >= 65 ? '65–69' : s >= 60 ? '60–64' : s >= 55 ? '55–59' : s >= 50 ? '50–54' : '<50');
export const SCORE_ORDER = ['<50', '50–54', '55–59', '60–64', '65–69', '70+', 'n/a'];
export const mcapBucket = (m: number | null) =>
  m == null ? 'n/a' : m < 100e3 ? '<$100k' : m < 333e3 ? '$100–333k' : m < 1e6 ? '$333k–1M' : m < 5e6 ? '$1–5M' : '$5M+';
export const MCAP_ORDER = ['<$100k', '$100–333k', '$333k–1M', '$1–5M', '$5M+', 'n/a'];
