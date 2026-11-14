// Small, dependency-free SVG charts that render on the server.

export type BarRow = { label: string; value: number; display?: string; sub?: string; color?: string; href?: string };

export function HBars({ rows, max, color = 'var(--color-gold)' }: { rows: BarRow[]; max?: number; color?: string }) {
  const m = max ?? Math.max(1e-9, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,12rem)_1fr_auto]">
          <div className="truncate text-dim" title={r.label}>
            {r.label}
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-panel-2">
            <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, (r.value / m) * 100)}%`, background: r.color ?? color }} />
          </div>
          <div className="num min-w-14 text-right text-text">
            {r.display ?? r.value}
            {r.sub && <span className="ml-1.5 text-xs text-faint">{r.sub}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export type Seg = { label: string; value: number; color: string };

export function StackBar({ segs }: { segs: Seg[] }) {
  const total = segs.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div>
      <div className="flex h-3.5 overflow-hidden rounded-full bg-panel-2">
        {segs.map((s) =>
          s.value ? <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} /> : null,
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-dim">
        {segs.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label} <span className="num text-text">{s.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Columns({ data, height = 160, color = 'var(--color-gold)', highlightFrom }: { data: { label: string; value: number; color?: string }[]; height?: number; color?: string; highlightFrom?: number }) {
  const m = Math.max(1, ...data.map((d) => d.value));
  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {data.map((d, i) => (
          <div key={d.label} className="flex h-full flex-1 flex-col justify-end" title={`${d.label}: ${d.value}`}>
            <div className="num mb-1 text-center text-[11px] text-dim">{d.value || ''}</div>
            <div
              className="w-full rounded-t-md"
              style={{
                height: `${(d.value / m) * 85}%`,
                minHeight: d.value ? 3 : 0,
                background: d.color ?? (highlightFrom != null && i >= highlightFrom ? 'var(--color-gold-2)' : color),
                opacity: highlightFrom != null && i < highlightFrom ? 0.55 : 1,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5">
        {data.map((d) => (
          <div key={d.label} className="flex-1 truncate text-center text-[10px] text-faint sm:text-[11px]">
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// Area/line over time. Points are [ms, value].
export function Area({ points, height = 120, color = 'var(--color-gold)', fmt = (v: number) => v.toFixed(0) }: { points: [number, number][]; height?: number; color?: string; fmt?: (v: number) => string }) {
  if (points.length < 2) return <div className="text-sm text-faint">Not enough data yet.</div>;
  const W = 600, H = 100;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.08 || 1;
  const sx = (t: number) => ((t - x0) / (x1 - x0 || 1)) * W;
  const sy = (v: number) => H - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * H;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
  const id = `g${Math.abs(Math.round(lo * 1000 + hi + points.length))}`;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${d}L${W},${H}L0,${H}Z`} fill={`url(#${id})`} />
        <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="num pointer-events-none absolute right-0 top-0 text-[11px] text-dim">{fmt(hi)}</div>
      <div className="num pointer-events-none absolute bottom-0 right-0 text-[11px] text-faint">{fmt(lo)}</div>
    </div>
  );
}

// Score vs peak multiple (log y). Each dot = one call.
export function Scatter({
  points,
  xLabel,
  yLabel,
  xDomain,
}: {
  points: { x: number; y: number; color: string; label: string; href?: string }[];
  xLabel: string;
  yLabel: string;
  xDomain?: [number, number];
}) {
  const W = 640, H = 300, L = 44, R = 12, T = 12, B = 34;
  const xs = points.map((p) => p.x);
  const [xa, xb] = xDomain ?? [Math.min(...xs) - 2, Math.max(...xs) + 2];
  const ya = Math.min(0.9, ...points.map((p) => p.y)) * 0.9, yb = Math.max(4, ...points.map((p) => p.y)) * 1.15;
  const sx = (v: number) => L + ((v - xa) / (xb - xa || 1)) * (W - L - R);
  const sy = (v: number) => T + (1 - (Math.log(Math.max(ya, v)) - Math.log(ya)) / (Math.log(yb) - Math.log(ya))) * (H - T - B);
  const yTicks = [0.5, 1, 1.5, 2, 3, 4, 5, 10].filter((t) => t <= yb && t >= ya);
  const xTicks: number[] = [];
  for (let t = Math.ceil(xa / 5) * 5; t <= xb; t += 5) xTicks.push(t);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${yLabel} by ${xLabel}`}>
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} stroke={t === 2 ? 'var(--color-gold-deep)' : 'var(--color-line)'} strokeDasharray={t === 2 ? '4 4' : undefined} />
          <text x={L - 8} y={sy(t) + 4} textAnchor="end" className="num" fontSize="11" fill="var(--color-faint)">
            {t}×
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <text key={t} x={sx(t)} y={H - 14} textAnchor="middle" className="num" fontSize="11" fill="var(--color-faint)">
          {t}
        </text>
      ))}
      <text x={W - R} y={H - 1} textAnchor="end" fontSize="11" fill="var(--color-faint)">
        {xLabel}
      </text>
      {points.map((p, i) => (
        <a key={i} href={p.href}>
          <circle cx={sx(p.x)} cy={sy(p.y)} r="6" fill={p.color} fillOpacity="0.8" stroke="var(--color-ink)" strokeWidth="1.5">
            <title>{p.label}</title>
          </circle>
        </a>
      ))}
    </svg>
  );
}

// Columns where part of each bar is highlighted (e.g. calls per week, and how many of those hit 2×)
export function SplitColumns({ data, height = 130 }: { data: { label: string; total: number; part: number }[]; height?: number }) {
  const m = Math.max(1, ...data.map((d) => d.total));
  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {data.map((d) => (
          <div key={d.label} className="flex h-full flex-1 flex-col justify-end" title={`${d.label}: ${d.total} calls, ${d.part} hit 2×`}>
            <div className="num mb-1 text-center text-[11px] text-dim">{d.total || ''}</div>
            <div className="flex w-full flex-col justify-end overflow-hidden rounded-t-md bg-line-2" style={{ height: `${(d.total / m) * 85}%`, minHeight: d.total ? 3 : 0 }}>
              <div className="w-full bg-gold" style={{ height: `${d.total ? (d.part / d.total) * 100 : 0}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5">
        {data.map((d) => (
          <div key={d.label} className="flex-1 truncate text-center text-[10px] text-faint sm:text-[11px]">
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
