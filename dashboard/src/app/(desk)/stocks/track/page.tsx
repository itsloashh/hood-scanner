import Link from 'next/link';
import { loadBacktest, loadPerf } from '@/lib/stocks';
import { Section, Empty } from '@/components/ui';
import { pctS } from '@/components/stock-ui';
import { date } from '@/lib/format';

export const revalidate = 600;
export const metadata = { title: 'Track record · Hood Desk' };

const ORDER = ['<40', '40–49', '50–59', '60–69', '70+'];

export default async function TrackPage() {
  const [perf, bt] = await Promise.all([loadPerf(), loadBacktest()]);
  const groups = Object.entries(perf?.groups ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <>
      <Section title="Every candidate since discovery" hint="Recorded once when it first scored 60+, never removed. Dividend-adjusted, minus 0.2% trading cost.">
        {perf?.candidates.length ? (
          <div className="scroll-x">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-faint">
                <tr className="border-b border-line">
                  <th className="py-2 font-medium">Stock</th><th className="py-2 font-medium">Discovered</th><th className="py-2 text-right font-medium">Score</th>
                  <th className="py-2 text-right font-medium">30d</th><th className="py-2 text-right font-medium">90d</th><th className="py-2 text-right font-medium">Total</th>
                  <th className="py-2 text-right font-medium">Benchmark</th><th className="py-2 text-right font-medium">Max DD</th>
                </tr>
              </thead>
              <tbody>
                {perf.candidates.sort((a, b) => b.discovered.localeCompare(a.discovered)).map((c) => (
                  <tr key={c.security_id} className="border-b border-line/60 last:border-0">
                    <td className="py-2"><Link href={`/stocks/${encodeURIComponent(c.security_id)}`} className="font-medium hover:text-gold-2">{c.ticker}</Link> <span className="text-xs text-faint">{c.profile}{c.experimental ? ' · micro' : ''}</span></td>
                    <td className="py-2 text-xs text-dim">{date(Date.parse(c.discovered), false)}</td>
                    <td className="num py-2 text-right">{Math.round(c.score)}</td>
                    <td className="num py-2 text-right">{pctS(c.ret_30d, 1)}</td>
                    <td className="num py-2 text-right">{pctS(c.ret_90d, 1)}</td>
                    <td className={`num py-2 text-right ${(c.ret_total ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>{pctS(c.ret_total, 1)}</td>
                    <td className="num py-2 text-right text-dim">{pctS(c.bench_total, 1)}</td>
                    <td className="num py-2 text-right text-dim">{c.max_drawdown != null ? `${Math.round(c.max_drawdown * 100)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No candidates recorded yet. The first research run seeds this list; returns fill in as 30/90/180/365-day windows close.</Empty>
        )}
        {groups.length > 0 && (
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {groups.map(([k, g]) => (
              <div key={k} className="rounded-lg bg-panel-2 p-3 text-sm">
                <div className="text-xs text-faint">{k.replace(':', ' · ')}</div>
                <div className="num">{g.n} names · avg {pctS(g.avg_return, 1)} · vs bench {pctS(g.avg_excess, 1)}</div>
              </div>
            ))}
          </div>
        )}
        <ul className="mt-3 space-y-0.5 text-xs text-faint">{perf?.notes.map((n) => <li key={n}>• {n}</li>)}</ul>
      </Section>

      <Section title="Backtest (point-in-time)" hint="Quarterly replay of the health + valuation + growth score using only filings public at each date" className="mt-4">
        {bt ? (
          <>
            <div className="scroll-x">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="text-left text-xs text-faint">
                  <tr className="border-b border-line">
                    <th className="py-2 font-medium">Score bucket</th><th className="py-2 text-right font-medium">Samples</th>
                    <th className="py-2 text-right font-medium">Next 3m</th><th className="py-2 text-right font-medium">vs SPY</th>
                    <th className="py-2 text-right font-medium">Beat SPY</th><th className="py-2 text-right font-medium">Next 6m vs SPY</th>
                  </tr>
                </thead>
                <tbody>
                  {ORDER.filter((k) => bt.buckets[k]).map((k) => {
                    const b = bt.buckets[k];
                    return (
                      <tr key={k} className="border-b border-line/60 last:border-0">
                        <td className="py-2">{k}</td><td className="num py-2 text-right text-dim">{b.n.toLocaleString()}</td>
                        <td className="num py-2 text-right">{pctS(b.avg_3m, 1)}</td>
                        <td className={`num py-2 text-right ${(b.excess_3m ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>{pctS(b.excess_3m, 1)}</td>
                        <td className="num py-2 text-right text-dim">{b.hit_3m != null ? `${Math.round(b.hit_3m * 100)}%` : '—'}</td>
                        <td className={`num py-2 text-right ${(b.excess_6m ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>{pctS(b.excess_6m, 1)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="mt-3 space-y-0.5 text-xs text-warn">{bt.limits.map((n) => <li key={n}>• {n}</li>)}</ul>
          </>
        ) : (
          <Empty>The backtest runs after the first full research run has cached filings and prices.</Empty>
        )}
      </Section>
    </>
  );
}
