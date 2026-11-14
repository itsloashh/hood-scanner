import Link from 'next/link';
import { loadAll } from '@/lib/data';
import { buildCalls, summary } from '@/lib/calls';
import { SplitColumns, StackBar } from '@/components/charts';
import { CoinLink, Mult, Outcome, PageHeader, Pill, Section, Stat, TierBadge } from '@/components/ui';
import { ago, date, pct, price, signedPct, usd } from '@/lib/format';

export const revalidate = 120;

function weekStart(ms: number) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.getTime();
}

export default async function Overview() {
  const { state, prices, prefs } = await loadAll();
  const calls = buildCalls(state, prices, prefs);
  const s = summary(calls);
  const run = state.lastRun;
  const eth = state.eth;

  // calls per week, split by whether they went on to hit 2×
  const weeks = new Map<number, { n: number; w: number }>();
  for (const c of calls) {
    const k = weekStart(c.firstAt);
    const v = weeks.get(k) ?? { n: 0, w: 0 };
    v.n += 1;
    if (c.hit2x) v.w += 1;
    weeks.set(k, v);
  }
  const weekRows = [...weeks.entries()].sort((a, b) => a[0] - b[0]).slice(-10);

  const best = [...calls].sort((a, b) => b.peakX - a.peakX).slice(0, 5);
  const recent = calls.slice(0, 6);
  const live = calls.filter((c) => c.status === 'open' && (c.pref === 'follow' || (c.nowX ?? 0) >= 1)).sort((a, b) => (b.nowX ?? 0) - (a.nowX ?? 0)).slice(0, 6);

  return (
    <>
      <PageHeader eyebrow="Robinhood Chain memecoins" title="Overview">
        <div className="flex flex-wrap gap-2">
          {run && <Pill tone={run.regime === 'risk-on' ? 'up' : run.regime === 'risk-off' ? 'down' : 'dim'}>Market {run.regime}</Pill>}
          {eth && (
            <Pill tone={eth.trend === 'strong' ? 'up' : eth.trend === 'weak' ? 'down' : 'dim'}>
              ETH {usd(eth.price, 0)} · <span className="num">{signedPct(eth.h24)}</span>
            </Pill>
          )}
          {run && <Pill>Last scan {ago(Date.parse(run.at))}</Pill>}
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Coins called" value={s.n} sub={`${calls.filter((c) => c.status === 'open').length} still being tracked`} />
        <Stat label="Hit 2×" value={s.hit2x} sub={`${pct(s.rate2x)} of calls`} tone="gold" />
        <Stat label="3× wins" value={s.win} sub="3× before −50%, within 30 days" tone="up" />
        <Stat label="Stopped" value={s.stopped} sub="fell 50% before 3×" tone="down" />
        <Stat label="Median peak" value={`${s.medPeak.toFixed(2)}×`} sub={s.best ? `best: $${s.best.symbol} ${s.best.peakX.toFixed(2)}×` : undefined} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Section title="How calls played out" hint="Peak since the first alert, per coin" className="lg:col-span-2">
          <StackBar
            segs={[
              { label: '3× win', value: s.win, color: 'var(--color-up)' },
              { label: 'Hit 2× (not 3×)', value: calls.filter((c) => c.hit2x && c.status !== 'win').length, color: 'var(--color-gold)' },
              { label: 'Open, under 2×', value: calls.filter((c) => !c.hit2x && c.status === 'open').length, color: 'var(--color-line-2)' },
              { label: 'Stopped, under 2×', value: calls.filter((c) => !c.hit2x && c.status === 'stopped').length, color: 'var(--color-down)' },
              { label: 'Expired', value: calls.filter((c) => !c.hit2x && c.status === 'expired').length, color: 'var(--color-faint)' },
            ]}
          />
          <div className="mt-6">
            <div className="eyebrow mb-3">Coins called per week · gold = went on to 2×</div>
            {weekRows.length ? (
              <SplitColumns data={weekRows.map(([k, v]) => ({ label: date(k, false), total: v.n, part: v.w }))} />
            ) : (
              <p className="text-sm text-faint">No calls yet.</p>
            )}
          </div>
        </Section>

        <Section title="Best calls" hint="Highest peak since the first alert" action={<Link href="/calls" className="text-xs text-gold hover:text-gold-2">All calls →</Link>}>
          <ol className="space-y-3">
            {best.map((c, i) => (
              <li key={c.token} className="flex items-center gap-3">
                <span className="num w-4 text-xs text-faint">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <CoinLink c={c} />
                  <div className="text-xs text-faint">
                    {date(c.firstAt, false)} · {c.lane} · {usd(c.mcapAtCall)}
                  </div>
                </div>
                <Mult v={c.peakX} strong />
              </li>
            ))}
          </ol>
        </Section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Latest calls" action={<Link href="/calls" className="text-xs text-gold hover:text-gold-2">See all →</Link>}>
          <ul className="divide-y divide-line">
            {recent.map((c) => (
              <li key={c.token} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <CoinLink c={c} />
                    <TierBadge tier={c.firstTier} />
                  </div>
                  <div className="text-xs text-faint">
                    {ago(c.firstAt)} · called at {price(c.firstPrice)}
                  </div>
                </div>
                <div className="text-right text-sm">
                  <Mult v={c.nowX} />
                  <div className="text-xs">
                    <Outcome c={c} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Still alive" hint="Open calls above their call price, plus coins you follow">
          {live.length ? (
            <ul className="divide-y divide-line">
              {live.map((c) => (
                <li key={c.token} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <CoinLink c={c} />
                    <div className="text-xs text-faint">
                      now {usd(c.nowMcap)} mcap · liq {usd(c.nowLiq)}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <Mult v={c.nowX} strong />
                    <div className="text-xs text-faint">peak {c.peakX.toFixed(2)}×</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-dim">No open calls are above their call price right now.</p>
          )}
        </Section>
      </div>
    </>
  );
}
