'use client';
import { useMemo, useRef, useState } from 'react';
import type { Candle } from '@/lib/data';
import { date, price as fmtPrice } from '@/lib/format';

type Marker = { at: number; label: string; color: string };

export function PriceChart({ candles, callPrice, markers }: { candles: Candle[]; callPrice: number; markers: Marker[] }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [log, setLog] = useState(true);
  const W = 800, H = 340, L = 8, R = 64, T = 14, B = 26;

  const g = useMemo(() => {
    const t0 = candles[0].t, t1 = candles[candles.length - 1].t;
    const vals = candles.flatMap((c) => [c.h, c.l]).filter((v) => v > 0);
    let lo = Math.min(...vals, callPrice * 0.9), hi = Math.max(...vals, callPrice * 1.1);
    const tf = (v: number) => (log ? Math.log(v) : v);
    const pad = (tf(hi) - tf(lo)) * 0.06;
    const a = tf(lo) - pad, b = tf(hi) + pad;
    const sx = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
    const sy = (v: number) => T + (1 - (tf(Math.max(v, 1e-30)) - a) / (b - a)) * (H - T - B);
    const line = candles.map((c, i) => `${i ? 'L' : 'M'}${sx(c.t).toFixed(1)},${sy(c.c).toFixed(1)}`).join('');
    const levels = [0.5, 1, 2, 3, 5, 10].map((k) => ({ k, v: callPrice * k })).filter((l) => l.v >= lo * 0.98 && l.v <= hi * 1.02);
    const vmax = Math.max(1, ...candles.map((c) => c.v));
    return { t0, t1, sx, sy, line, levels, vmax, lo, hi };
  }, [candles, callPrice, log]);

  function onMove(e: React.PointerEvent) {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = g.t0 + ((px - L) / (W - L - R)) * (g.t1 - g.t0);
    let best = 0;
    for (let i = 1; i < candles.length; i++) if (Math.abs(candles[i].t - t) < Math.abs(candles[best].t - t)) best = i;
    setHover(best);
  }

  const h = hover != null ? candles[hover] : null;
  const last = candles[candles.length - 1];
  const show = h ?? last;
  const mult = show.c / callPrice;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="num text-lg">{fmtPrice(show.c)}</span>
          <span className={`num ${mult >= 2 ? 'text-gold-2' : mult >= 1 ? 'text-up' : 'text-down'}`}>{mult.toFixed(2)}× call</span>
          <span className="text-xs text-faint">{h ? date(h.t) : 'latest'}</span>
        </div>
        <button onClick={() => setLog((v) => !v)} className="rounded-md border border-line-2 px-2 py-1 text-xs text-dim hover:text-text">
          {log ? 'Log scale' : 'Linear'}
        </button>
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-pan-y select-none"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {/* volume */}
        {candles.map((c) => {
          const bh = (c.v / g.vmax) * 50;
          return <rect key={c.t} x={g.sx(c.t) - 1} y={H - B - bh} width={2} height={bh} fill="var(--color-line-2)" />;
        })}
        {/* multiple levels vs call price */}
        {g.levels.map((l) => (
          <g key={l.k}>
            <line x1={L} x2={W - R} y1={g.sy(l.v)} y2={g.sy(l.v)} stroke={l.k === 1 ? 'var(--color-gold)' : l.k < 1 ? 'var(--color-down)' : 'var(--color-gold-deep)'} strokeOpacity={l.k === 1 ? 0.8 : 0.45} strokeDasharray={l.k === 1 ? undefined : '4 5'} />
            <text x={W - R + 6} y={g.sy(l.v) + 4} fontSize="11" fill={l.k === 1 ? 'var(--color-gold-2)' : 'var(--color-faint)'} className="num">
              {l.k === 1 ? 'call' : `${l.k}×`}
            </text>
          </g>
        ))}
        <path d={g.line} fill="none" stroke="var(--color-text)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {/* event markers */}
        {markers
          .filter((m) => m.at >= g.t0 && m.at <= g.t1)
          .map((m, i) => {
            const mx = g.sx(m.at);
            return (
              <g key={`${m.label}-${m.at}`}>
                <line x1={mx} x2={mx} y1={T} y2={H - B} stroke={m.color} strokeOpacity="0.55" strokeDasharray="2 4" />
                <rect x={mx - 3} y={T + 2 + (i % 3) * 18} width={Math.max(40, m.label.length * 6.6)} height={15} rx={4} fill="var(--color-ink)" stroke={m.color} strokeOpacity="0.6" />
                <text x={mx + 2} y={T + 13 + (i % 3) * 18} fontSize="10.5" fill={m.color}>
                  {m.label}
                </text>
              </g>
            );
          })}
        {h && (
          <g>
            <line x1={g.sx(h.t)} x2={g.sx(h.t)} y1={T} y2={H - B} stroke="var(--color-dim)" strokeOpacity="0.5" />
            <circle cx={g.sx(h.t)} cy={g.sy(h.c)} r="4" fill="var(--color-gold-2)" />
          </g>
        )}
        <text x={L} y={H - 6} fontSize="11" fill="var(--color-faint)">
          {date(g.t0, false)}
        </text>
        <text x={W - R} y={H - 6} fontSize="11" fill="var(--color-faint)" textAnchor="end">
          {date(g.t1, false)}
        </text>
      </svg>
    </div>
  );
}
