import Link from 'next/link';
import { loadAll } from '@/lib/data';
import { buildCalls, summary } from '@/lib/calls';
import { classTone, loadDetail, loadOpps, loadStockAlerts, loadUniverse, type Row } from '@/lib/stocks';
import { ZoneBar } from '@/components/ZoneBar';
import { Mult, Pill } from '@/components/ui';
import { ago, price, signedPct, usd } from '@/lib/format';

export const dynamic = 'force-dynamic';

function Kpi({ href, label, value, sub }: { href: string; label: string; value: React.ReactNode; sub?: string }) {
  return (
    <Link href={href} className="card tap block min-w-0 p-4">
      <div className="eyebrow">{label}</div>
      <div className="num mt-1.5 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-dim">{sub}</div>}
    </Link>
  );
}

export default async function Desk() {
  const [{ state, prices, prefs }, uni, opps, salerts] = await Promise.all([loadAll(), loadUniverse(), loadOpps(), loadStockAlerts()]);
  const calls = buildCalls(state, prices, prefs);
  const s = summary(calls);
  const liveCoins = calls.filter((c) => c.status === 'open' && c.ageDays <= 14).slice(0, 6);
  const byId = new Map(uni.rows.map((r) => [r.id, r]));
  const topStocks = (opps?.top ?? []).map((i) => byId.get(i)).filter((r): r is Row => !!r).slice(0, 6);
  const details = await Promise.all(topStocks.map((r) => loadDetail(r.id)));
  const day = 86_400_000;
  const alerts24 =
    state.scorecard.filter((e) => Date.now() - e.at < day).length +
    Object.values(state.called ?? {}).reduce((n, c) => n + Object.values(c.milestones ?? {}).filter((at) => Date.now() - at < day).length, 0) +
    (salerts?.log ?? []).filter((a) => a.delivery_status === 'sent' && Date.now() - Date.parse(a.created_at) < day).length;
  const spy = opps?.etfs.find((e) => e.ticker === 'SPY');
  const run = state.lastRun;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow mb-1">Your desk</div>
          <h1 className="display text-3xl @3xl:text-4xl">Today’s calls</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {run && <Pill tone={run.regime === 'risk-on' ? 'up' : run.regime === 'risk-off' ? 'down' : 'dim'}>Chain {run.regime}</Pill>}
          {state.eth && (
            <Pill>
              ETH {usd(state.eth.price, 0)} <span className="num">{signedPct(state.eth.h24)}</span>
            </Pill>
          )}
          {spy?.ret_3m != null && (
            <Pill>
              SPY 3m <span className="num">{signedPct(spy.ret_3m * 100)}</span>
            </Pill>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Kpi href="/alerts" label="Alerts · 24h" value={alerts24} sub="coins + stocks" />
        <Kpi href="/coins" label="Coin calls hit 2×" value={`${s.hit2x}/${s.n}`} sub={`${Math.round(s.rate2x * 100)}% · median peak ${s.medPeak.toFixed(2)}×`} />
        <Kpi href="/stocks" label="Stocks 70+" value={uni.rows.filter((r) => r.score >= 70 && !r.experimental && !r.quarantined).length} sub={`of ${uni.count.toLocaleString()} scored`} />
        <Kpi href="/stocks/screener" label="Insider buying" value={uni.rows.filter((r) => r.insider_buyers_90d > 0).length} sub="stocks, last 90 days" />
      </div>

      <section className="mt-6">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="display text-xl">Live coin calls</h2>
          <Link href="/coins" className="text-sm font-medium text-gold-2">All coins →</Link>
        </div>
        <div className="grid gap-3 @3xl:grid-cols-2 @5xl:grid-cols-3">
          {liveCoins.map((c) => {
            const z = c.zones?.swing;
            return (
              <Link key={c.token} href={`/coins/${c.token}`} className="card tap block min-w-0 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">${c.symbol}</div>
                    <div className="text-xs text-faint">
                      {c.lane} · called {ago(c.firstAt)} at {price(c.firstPrice)}
                    </div>
                  </div>
                  <div className="text-right">
                    <Mult v={c.nowX} strong />
                    <div className="text-[11px] text-faint">peak {c.peakX.toFixed(2)}×</div>
                  </div>
                </div>
                <div className="mt-3">
                  {z ? (
                    <ZoneBar stop={z.stop} entry={z.entry} tps={z.tps.map((t) => ({ label: t.l, price: t.p }))} now={c.nowPrice} />
                  ) : (
                    <p className="text-xs text-faint">Zones start with new calls — open for the live chart and current zones.</p>
                  )}
                </div>
              </Link>
            );
          })}
          {!liveCoins.length && <div className="card p-6 text-sm text-dim">No open coin calls from the last two weeks.</div>}
        </div>
      </section>

      <section className="mt-6">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="display text-xl">Top stock candidates</h2>
          <Link href="/stocks" className="text-sm font-medium text-gold-2">All stocks →</Link>
        </div>
        <div className="grid gap-3 @3xl:grid-cols-2 @5xl:grid-cols-3">
          {topStocks.map((r, i) => {
            const z = details[i]?.zones?.swing;
            return (
              <Link key={r.id} href={`/stocks/${encodeURIComponent(r.id)}`} className="card tap block min-w-0 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold">
                      {r.ticker} <span className="text-xs font-normal text-faint">{r.profile}</span>
                    </div>
                    <div className="truncate text-xs text-faint">{r.name}</div>
                  </div>
                  <div className="flex gap-3 text-right">
                    <div>
                      <div className={`num text-lg font-semibold ${classTone(r.score)}`}>{Math.round(r.score)}</div>
                      <div className="text-[10px] text-faint">score</div>
                    </div>
                    <div>
                      <div className="num text-lg text-dim">{r.confidence}</div>
                      <div className="text-[10px] text-faint">evidence</div>
                    </div>
                  </div>
                </div>
                <div className="mt-3">
                  {z ? (
                    <ZoneBar stop={z.stop} entry={z.entry} tps={z.tps.map((t) => ({ label: t.label, price: t.price }))} now={r.price} />
                  ) : (
                    <p className="text-xs text-faint">Zones appear after the next stock run.</p>
                  )}
                </div>
              </Link>
            );
          })}
          {!topStocks.length && <div className="card p-6 text-sm text-dim">The stock engine hasn’t published candidates yet.</div>}
        </div>
      </section>
    </>
  );
}
