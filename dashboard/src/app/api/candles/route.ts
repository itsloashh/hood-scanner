// Candles for the trade chart. Coins: GeckoTerminal (Robinhood Chain pools). Stocks: Yahoo (delayed).
// Auth: the proxy only lets signed-in requests through.
import { NextResponse, type NextRequest } from 'next/server';

const TF: Record<string, { gt: [string, number, number]; yf: [string, string] }> = {
  '15m': { gt: ['minute', 15, 300], yf: ['15m', '5d'] },
  '1h': { gt: ['hour', 1, 300], yf: ['60m', '1mo'] },
  '4h': { gt: ['hour', 4, 300], yf: ['60m', '3mo'] },
  '1d': { gt: ['day', 1, 300], yf: ['1d', '2y'] },
};
const UA = 'Mozilla/5.0 (compatible; hood-desk/1.0; +github.com/itsloashh/hood-scanner)';

type C = { t: number; o: number; h: number; l: number; c: number; v: number };

function to4h(c: C[]): C[] {
  const out: C[] = [];
  for (const k of c) {
    const b = Math.floor(k.t / 14400) * 14400;
    const last = out[out.length - 1];
    if (last && last.t === b) {
      last.h = Math.max(last.h, k.h);
      last.l = Math.min(last.l, k.l);
      last.c = k.c;
      last.v += k.v;
    } else out.push({ ...k, t: b });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tf = TF[q.get('tf') || '1h'] ? (q.get('tf') as string) : '1h';
  if (process.env.CANDLES_MOCK) {
    // local preview only: SYNTHETIC random walk (never set in production)
    const step = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }[tf] ?? 3600;
    let p = q.get('kind') === 'coin' ? 0.0001 : 30;
    const now = Math.floor(Date.now() / 1000 / step) * step;
    const candles = Array.from({ length: 200 }, (_, i) => {
      const o = p;
      p = Math.max(p * (1 + Math.sin(i / 9) * 0.02 + (Math.random() - 0.5) * 0.03), 1e-9);
      return { t: now - (199 - i) * step, o, h: Math.max(o, p) * 1.01, l: Math.min(o, p) * 0.99, c: p, v: 1000 + Math.random() * 500 };
    });
    return NextResponse.json({ candles, source: 'SYNTHETIC' });
  }
  try {
    if (q.get('kind') === 'coin') {
      const pool = (q.get('pool') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(pool)) return NextResponse.json({ error: 'bad pool' }, { status: 400 });
      const [unit, agg, limit] = TF[tf].gt;
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&limit=${limit}&currency=usd&token=base`, {
        headers: { accept: 'application/json' },
        next: { revalidate: 60 },
      });
      if (!res.ok) return NextResponse.json({ error: `GeckoTerminal ${res.status}`, candles: [] }, { status: 200 });
      const j = await res.json();
      const candles: C[] = (j?.data?.attributes?.ohlcv_list ?? []).map(([t, o, h, l, c, v]: number[]) => ({ t, o: +o, h: +h, l: +l, c: +c, v: +v })).sort((a: C, b: C) => a.t - b.t);
      return NextResponse.json({ candles, source: 'GeckoTerminal' });
    }
    const sym = q.get('symbol') || '';
    if (!/^[A-Z0-9.\-=^]{1,15}$/i.test(sym)) return NextResponse.json({ error: 'bad symbol' }, { status: 400 });
    const [interval, range] = TF[tf].yf;
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`, {
      headers: { 'User-Agent': UA, accept: '*/*' },
      next: { revalidate: 60 },
    });
    if (!res.ok) return NextResponse.json({ error: `Yahoo ${res.status}`, candles: [] }, { status: 200 });
    const r = (await res.json())?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const qd = r?.indicators?.quote?.[0] ?? {};
    let candles: C[] = ts
      .map((t, i) => ({ t, o: qd.open?.[i], h: qd.high?.[i], l: qd.low?.[i], c: qd.close?.[i], v: qd.volume?.[i] ?? 0 }))
      .filter((k) => k.c != null && k.h != null && k.l != null && k.o != null);
    if (tf === '4h') candles = to4h(candles);
    return NextResponse.json({ candles, source: 'Yahoo (delayed)', currency: r?.meta?.currency });
  } catch (e) {
    return NextResponse.json({ error: String(e), candles: [] }, { status: 200 });
  }
}
