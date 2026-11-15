'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { plan, normalize, type Candle, type Plan, type StoredPlan } from '@/lib/zones';
import { price as fmtPrice } from '@/lib/format';

type Props = {
  kind: 'coin' | 'stock';
  pool?: string | null; // coins
  symbol?: string | null; // stocks (Yahoo symbol)
  callPrice?: number | null;
  callAt?: number | null; // ms
  stored?: { swing?: StoredPlan; scalp?: StoredPlan } | null; // zones recorded when the call was made
  runner?: number | null;
  currency?: string;
};

const TFS = ['15m', '1h', '4h', '1d'] as const;
type TF = (typeof TFS)[number];

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function load(p: Props, tf: TF): Promise<Candle[]> {
  const q = p.kind === 'coin' ? `kind=coin&pool=${p.pool}` : `kind=stock&symbol=${encodeURIComponent(p.symbol || '')}`;
  const r = await fetch(`/api/candles?${q}&tf=${tf}`);
  const j = await r.json();
  return j.candles ?? [];
}

export function TradeChart(p: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const [tf, setTf] = useState<TF>(p.kind === 'coin' ? '1h' : '1d');
  const [mode, setMode] = useState<'swing' | 'scalp'>('swing');
  const [source, setSource] = useState<'live' | 'call'>('live');
  const [shown, setShown] = useState<Candle[]>([]);
  const [daily, setDaily] = useState<Candle[]>([]);
  const [hourly, setHourly] = useState<Candle[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // candles for zone math: daily → swing, hourly → scalp (fetched once)
  useEffect(() => {
    load(p, '1d').then(setDaily).catch(() => {});
    load(p, '1h').then(setHourly).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.pool, p.symbol]);

  useEffect(() => {
    let off = false;
    setLoading(true);
    load(p, tf)
      .then((c) => {
        if (off) return;
        setShown(c);
        setErr(c.length ? null : 'No candles available right now (the data source may be rate limiting). Try another timeframe or refresh.');
      })
      .catch(() => !off && setErr('Couldn’t load candles.'))
      .finally(() => !off && setLoading(false));
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf, p.pool, p.symbol]);

  const last = shown.at(-1)?.c ?? daily.at(-1)?.c ?? hourly.at(-1)?.c ?? null;
  const live = useMemo<Plan | null>(() => {
    if (!last) return null;
    return mode === 'swing' ? plan(daily.length ? daily : shown, last, { maxStopPct: p.kind === 'coin' ? 0.5 : 0.25, runner: p.runner ?? null }) : plan(hourly.length ? hourly : shown, last, { maxStopPct: p.kind === 'coin' ? 0.25 : 0.08, scalp: true });
  }, [mode, daily, hourly, shown, last, p.kind, p.runner]);
  const atCall = useMemo(() => normalize(mode === 'swing' ? p.stored?.swing : p.stored?.scalp), [mode, p.stored]);
  const z = source === 'call' && atCall ? atCall : live;

  // build chart once
  useEffect(() => {
    if (!box.current) return;
    const text = css('--color-dim') || '#555';
    const line = css('--color-line') || '#e5e5e5';
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: text, fontFamily: 'Inter Variable, system-ui, sans-serif', attributionLogo: false },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.18 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { locale: 'en-US' },
    });
    const up = css('--color-up') || '#0e9f6e';
    const down = css('--color-down') || '#e5484d';
    const s = chart.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false,
      priceFormat: { type: 'custom', minMove: 1e-12, formatter: (v: number) => fmtPrice(v).replace('$', '') },
    });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, color: 'rgba(120,120,160,0.25)', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    chartRef.current = chart;
    seriesRef.current = s;
    (chart as unknown as { _vol: typeof vol })._vol = vol;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // data
  useEffect(() => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    if (!s || !chart || !shown.length) return;
    s.setData(shown.map((k) => ({ time: k.t as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c })));
    const vol = (chart as unknown as { _vol: ISeriesApi<'Histogram'> })._vol;
    vol.setData(shown.map((k) => ({ time: k.t as UTCTimestamp, value: k.v ?? 0, color: k.c >= k.o ? 'rgba(14,159,110,0.25)' : 'rgba(229,72,77,0.25)' })));
    if (p.callAt) {
      const t = Math.floor(p.callAt / 1000);
      const bar = [...shown].reverse().find((k) => k.t <= t);
      if (bar) createSeriesMarkers(s, [{ time: bar.t as UTCTimestamp, position: 'belowBar', color: css('--color-gold') || '#5b4bff', shape: 'arrowUp', text: 'Call' }]);
    }
    chart.timeScale().fitContent();
  }, [shown, p.callAt]);

  // zone lines
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const l of linesRef.current) s.removePriceLine(l);
    linesRef.current = [];
    const add = (price: number, color: string, title: string, style = LineStyle.Dashed, width: 1 | 2 = 1) => {
      if (!Number.isFinite(price) || price <= 0) return;
      linesRef.current.push(s.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title }));
    };
    const up = css('--color-up') || '#0e9f6e';
    const down = css('--color-down') || '#e5484d';
    const acc = css('--color-gold') || '#5b4bff';
    if (p.callPrice) add(p.callPrice, acc, 'Call', LineStyle.Solid, 1);
    if (z) {
      add(z.entry[0], '#1f7ae0', 'Entry low', LineStyle.Dotted);
      add(z.entry[1], '#1f7ae0', 'Entry', LineStyle.Dotted);
      add(z.stop, down, 'Stop', LineStyle.Solid, 2);
      for (const t of z.tps) add(t.price, up, t.label);
    }
  }, [z, p.callPrice, shown]);

  const ref = last ?? 0;
  const pct = (x: number) => (ref ? `${x >= ref ? '+' : ''}${((x / ref - 1) * 100).toFixed(1)}%` : '');
  const cur = p.currency === 'CAD' ? 'C' : '';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border border-line bg-panel-2 p-1">
          {TFS.map((t) => (
            <button key={t} onClick={() => setTf(t)} className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${tf === t ? 'bg-panel text-gold-2 shadow-[var(--shadow-glow)]' : 'text-dim'}`}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="flex rounded-xl border border-line bg-panel-2 p-1">
          {(['swing', 'scalp'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`rounded-lg px-2.5 py-1 text-xs font-semibold capitalize ${mode === m ? 'bg-panel text-gold-2 shadow-[var(--shadow-glow)]' : 'text-dim'}`}>
              {m}
            </button>
          ))}
        </div>
        {(p.stored?.swing || p.stored?.scalp) && (
          <div className="flex rounded-xl border border-line bg-panel-2 p-1">
            {(['live', 'call'] as const).map((m) => (
              <button key={m} onClick={() => setSource(m)} className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${source === m ? 'bg-panel text-gold-2 shadow-[var(--shadow-glow)]' : 'text-dim'}`}>
                {m === 'live' ? 'Zones now' : 'At call'}
              </button>
            ))}
          </div>
        )}
        {loading && <span className="text-xs text-faint">Loading…</span>}
      </div>
      <div ref={box} className="h-[340px] w-full @3xl:h-[440px]" />
      {err && <p className="mt-2 text-sm text-warn">{err}</p>}
      {z ? (
        <div className="mt-3 grid grid-cols-2 gap-2 text-sm @2xl:grid-cols-4">
          <Level label="Entry zone" v={`${cur}${fmtPrice(z.entry[0])} – ${cur}${fmtPrice(z.entry[1])}`} tone="info" />
          <Level label="Stop / invalidation" v={`${cur}${fmtPrice(z.stop)}`} sub={pct(z.stop)} tone="down" />
          {z.tps.map((t) => (
            <Level key={t.label} label={`${t.label}${t.why ? ` · ${t.why}` : ''}`} v={`${cur}${fmtPrice(t.price)}`} sub={`${pct(t.price)}${t.rr != null ? ` · ${t.rr.toFixed(1)}R` : ''}`} tone="up" />
          ))}
          <Level label="Hold zone" v={`above ${cur}${fmtPrice(z.hold[0])}`} sub="move stop to entry after TP1" tone="dim" />
        </div>
      ) : (
        !loading && <p className="mt-3 text-sm text-dim">Not enough candles to work out zones on this timeframe yet.</p>
      )}
      <p className="mt-2 text-[11px] text-faint">
        {mode === 'swing' ? 'Swing zones from daily candles' : 'Scalp zones from hourly candles'} · ATR + swing highs/lows · {source === 'call' ? 'as recorded when the call was made' : 'recalculated from the latest candles'} · speculative, not advice
      </p>
    </div>
  );
}

function Level({ label, v, sub, tone }: { label: string; v: string; sub?: string; tone: 'up' | 'down' | 'info' | 'dim' }) {
  const t = { up: 'text-up', down: 'text-down', info: 'text-info', dim: 'text-dim' }[tone];
  return (
    <div className="rounded-xl border border-line bg-panel-2/60 px-3 py-2">
      <div className="truncate text-[11px] text-faint">{label}</div>
      <div className={`num font-semibold ${t}`}>{v}</div>
      {sub && <div className="num text-[11px] text-faint">{sub}</div>}
    </div>
  );
}
