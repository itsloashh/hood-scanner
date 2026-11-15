import { price as fmtPrice } from '@/lib/format';

// A compact "where is price vs the plan" strip: stop · entry zone · now · take-profits
export function ZoneBar({ stop, entry, tps, now }: { stop: number; entry: [number, number] | number[]; tps: { label: string; price: number }[]; now: number | null }) {
  const pts = [stop, entry[0], entry[1], ...tps.map((t) => t.price), ...(now ? [now] : [])].filter((x) => Number.isFinite(x) && x > 0);
  if (pts.length < 3) return null;
  const lo = Math.min(...pts) * 0.995;
  const hi = Math.max(...pts) * 1.005;
  const x = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100))}%`;
  const state = now == null ? null : now <= stop ? 'Below stop' : now < entry[0] ? 'Under entry' : now <= entry[1] * 1.01 ? 'In entry zone' : tps[0] && now >= tps[0].price ? `Past ${tps.filter((t) => now >= t.price).at(-1)?.label}` : 'Holding';
  const tone = state === 'Below stop' ? 'text-down' : state?.startsWith('Past') ? 'text-up' : state === 'In entry zone' ? 'text-info' : 'text-dim';
  return (
    <div>
      <div className="relative h-2 rounded-full bg-panel-2">
        <div className="absolute inset-y-0 rounded-l-full bg-down/25" style={{ left: 0, width: x(entry[0]) }} />
        <div className="absolute inset-y-0 bg-info/35" style={{ left: x(entry[0]), width: `calc(${x(entry[1])} - ${x(entry[0])})` }} />
        <div className="absolute inset-y-0 rounded-r-full bg-up/20" style={{ left: x(entry[1]), right: 0 }} />
        <div className="absolute -top-0.5 h-3 w-0.5 bg-down" style={{ left: x(stop) }} title={`Stop ${fmtPrice(stop)}`} />
        {tps.map((t) => (
          <div key={t.label} className="absolute -top-0.5 h-3 w-0.5 bg-up" style={{ left: x(t.price) }} title={`${t.label} ${fmtPrice(t.price)}`} />
        ))}
        {now != null && <div className="absolute -top-1 h-4 w-4 -translate-x-1/2 rounded-full border-2 border-panel bg-gold shadow-[var(--shadow-glow)]" style={{ left: x(now) }} title={`Now ${fmtPrice(now)}`} />}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-faint">
        <span className="num">stop {fmtPrice(stop)}</span>
        {state && <span className={`font-semibold ${tone}`}>{state}</span>}
        <span className="num">{tps.at(-1)?.label} {fmtPrice(tps.at(-1)?.price ?? 0)}</span>
      </div>
    </div>
  );
}
