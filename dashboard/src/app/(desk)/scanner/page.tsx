import { loadAll } from '@/lib/data';
import { Area, HBars } from '@/components/charts';
import { PageHeader, Pill, Section, Stat } from '@/components/ui';
import { ago, date, signedPct, usd } from '@/lib/format';

export const revalidate = 120;
export const metadata = { title: 'Scanner · Hood Desk' };

export default async function ScannerPage() {
  const { state } = await loadAll();
  const run = state.lastRun;
  const lastAt = run ? Date.parse(run.at) : null;
  const stale = lastAt ? Date.now() - lastAt > 45 * 60_000 : true;
  const funnel = state.funnel24h ?? [];

  // reasons coins were cut, summed over the last 24h
  const cuts = new Map<string, number>();
  for (const f of funnel) for (const [k, v] of Object.entries(f.reasons ?? {})) {
    const key = k.startsWith('quality lane: only') ? 'quality lane: not far enough off its high' : k.startsWith('quality lane:') && k.includes('too broken') ? 'quality lane: too far off its high' : k;
    cuts.set(key, (cuts.get(key) ?? 0) + v);
  }
  const cutRows = [...cuts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const cutTotal = cutRows.reduce((s, [, v]) => s + v, 0) || 1;

  const http = Object.entries(run?.http ?? {});

  return (
    <>
      <PageHeader eyebrow="Is the bot healthy?" title="Scanner">
        <div className="flex flex-wrap gap-2">
          <Pill tone={stale ? 'warn' : 'up'}>{stale ? 'No scan in 45+ min' : 'Running'} · last {ago(lastAt)}</Pill>
          {state.runs != null && <Pill>{state.runs.toLocaleString()} scans total</Pill>}
        </div>
      </PageHeader>

      {run && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Stat label="Coins scanned" value={run.scanned} sub={`${run.universe} in the universe`} />
            <Stat label="Passed quick filter" value={run.quickPass} />
            <Stat label="Passed deep check" value={run.deepPass} sub={`${run.micro} micro · ${run.quality} quality`} />
            <Stat label="Alerts this scan" value={run.buy + run.watch + run.ignition + run.pump} sub={`${run.buy} buy · ${run.watch} watch`} tone="gold" />
            <Stat label="Profile misses" value={run.profileMiss ?? 0} sub="scored, but not like past winners" />
            <Stat label="Watchlist" value={run.watchlist} sub={`market ${run.regime}`} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Section title="Why coins get cut" hint={`Last 24h, across ${funnel.length} scans`}>
              <HBars rows={cutRows.map(([k, v]) => ({ label: k, value: v, display: `${Math.round((v / cutTotal) * 100)}%` }))} color="var(--color-line-2)" />
            </Section>
            <Section title="Coins passing each stage" hint="Last 24h — quick filter (top) and deep check (bottom)">
              <Area points={funnel.map((f) => [f.t, f.quickPass] as [number, number])} height={90} color="var(--color-info)" />
              <div className="mt-4" />
              <Area points={funnel.map((f) => [f.t, f.deepPass] as [number, number])} height={70} color="var(--color-gold)" />
              <div className="mt-2 flex justify-between text-[11px] text-faint">
                <span>{date(funnel[0]?.t)}</span>
                <span>{date(funnel.at(-1)?.t)}</span>
              </div>
            </Section>
          </div>
        </>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="ETH" hint={state.eth ? `${usd(state.eth.price, 0)} · 24h ${signedPct(state.eth.h24)} · 7d ${signedPct(state.eth.d7)} · trend ${state.eth.trend}` : undefined}>
          <Area points={(state.ethHistory ?? []).map(([t, p]) => [t, p] as [number, number])} fmt={(v) => usd(v, 0)} />
        </Section>
        <Section title="Chain volume (24h)" hint="Sum across scanned pools — drives the risk-on / risk-off regime">
          <Area points={(state.volumeHistory ?? []).map((v) => [v.t, v.v] as [number, number])} fmt={(v) => usd(v)} color="var(--color-up)" />
        </Section>
      </div>

      <Section title="Data sources, last scan" hint="Calls, seconds spent, and rate limits per API" className="mt-4">
        {http.length ? (
          <div className="scroll-x">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="text-left text-xs text-faint">
                <tr className="border-b border-line">
                  <th className="py-2 font-medium">Source</th>
                  <th className="py-2 text-right font-medium">Calls</th>
                  <th className="py-2 text-right font-medium">Seconds</th>
                  <th className="py-2 text-right font-medium">Waiting</th>
                  <th className="py-2 text-right font-medium">Rate-limited</th>
                </tr>
              </thead>
              <tbody>
                {http.map(([k, v]) => (
                  <tr key={k} className="border-b border-line/60 last:border-0">
                    <td className="py-2.5">{k}</td>
                    <td className="num py-2.5 text-right">{v.calls}</td>
                    <td className="num py-2.5 text-right text-dim">{v.sec}</td>
                    <td className="num py-2.5 text-right text-dim">{v.waitSec ?? 0}s</td>
                    <td className={`num py-2.5 text-right ${(v.r429 ?? 0) > 10 ? 'text-warn' : 'text-dim'}`}>{v.r429 ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-dim">No API stats in the last scan.</p>
        )}
        {run?.phases && (
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-dim">
            {Object.entries(run.phases).map(([k, v]) => (
              <span key={k} className="rounded-md bg-panel-2 px-2 py-1">
                {k} <span className="num text-text">{v}s</span>
              </span>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
