import { loadAll } from '@/lib/data';
import { buildCalls, groupBy, MCAP_ORDER, median, SCORE_ORDER, mcapBucket, scoreBucket, summary, type Call, type Group } from '@/lib/calls';
import { Columns, HBars, Scatter } from '@/components/charts';
import { PageHeader, Section } from '@/components/ui';
import { pct, usd } from '@/lib/format';

export const revalidate = 300;
export const metadata = { title: 'Analysis · Hood Desk' };

const TIER_LABEL: Record<string, string> = { watch: 'Watch', buy: 'Buy zone', ignition: 'Ignition', pump: 'Pump' };

function rateRows(groups: Group[], label: (k: string) => string = (k) => k) {
  return groups.map((g) => ({
    label: label(g.key),
    value: g.rate2x,
    display: pct(g.rate2x),
    sub: `${g.hit2x}/${g.n}`,
    color: g.n < 3 ? 'var(--color-gold-deep)' : 'var(--color-gold)',
  }));
}

function Compare({ calls }: { calls: Call[] }) {
  const w = calls.filter((c) => c.hit2x);
  const l = calls.filter((c) => !c.hit2x && c.status !== 'open');
  const rows: [string, (c: Call) => number | null, (v: number) => string][] = [
    ['Market cap at call', (c) => c.mcapAtCall, (v) => usd(v)],
    ['Score at call', (c) => c.score, (v) => v.toFixed(0)],
    ['Best score', (c) => c.bestScore, (v) => v.toFixed(0)],
    ['Lowest point', (c) => c.lowX, (v) => `${v.toFixed(2)}×`],
    ['Alerts per coin', (c) => c.events.length, (v) => v.toFixed(1)],
  ];
  const med = (cs: Call[], f: (c: Call) => number | null) => {
    const xs = cs.map(f).filter((v): v is number => v != null && isFinite(v));
    return xs.length ? median(xs) : null;
  };
  const share = (cs: Call[], f: (c: Call) => boolean) => (cs.length ? pct(cs.filter(f).length / cs.length) : '—');
  return (
    <div className="scroll-x">
      <table className="w-full min-w-[340px] text-sm">
        <thead className="text-left text-xs text-faint">
          <tr className="border-b border-line">
            <th className="py-2 font-medium">Median / share</th>
            <th className="py-2 text-right font-medium text-gold-2">Hit 2× ({w.length})</th>
            <th className="py-2 text-right font-medium">Closed under 2× ({l.length})</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, f, fmt]) => {
            const a = med(w, f), b = med(l, f);
            return (
              <tr key={name} className="border-b border-line/60">
                <td className="py-2.5 text-dim">{name}</td>
                <td className="num py-2.5 text-right">{a == null ? '—' : fmt(a)}</td>
                <td className="num py-2.5 text-right text-dim">{b == null ? '—' : fmt(b)}</td>
              </tr>
            );
          })}
          {[
            ['Micro lane', (c: Call) => c.lane === 'micro'],
            ['Utility coins', (c: Call) => c.kind === 'utility'],
            ['First alert was Watch', (c: Call) => c.firstTier === 'watch'],
            ['First alert was Buy zone', (c: Call) => c.firstTier === 'buy'],
            ['Had an Ignition alert', (c: Call) => c.ignitionAt != null],
          ].map(([name, f]) => (
            <tr key={name as string} className="border-b border-line/60 last:border-0">
              <td className="py-2.5 text-dim">{name as string}</td>
              <td className="num py-2.5 text-right">{share(w, f as (c: Call) => boolean)}</td>
              <td className="num py-2.5 text-right text-dim">{share(l, f as (c: Call) => boolean)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AnalysisPage() {
  const { state, prices, prefs } = await loadAll();
  const calls = buildCalls(state, prices, prefs);
  const s = summary(calls);

  const peakBuckets: [string, (x: number) => boolean][] = [
    ['Never up', (x) => x < 1.0001],
    ['1–1.5×', (x) => x >= 1.0001 && x < 1.5],
    ['1.5–2×', (x) => x >= 1.5 && x < 2],
    ['2–3×', (x) => x >= 2 && x < 3],
    ['3–5×', (x) => x >= 3 && x < 5],
    ['5×+', (x) => x >= 5],
  ];
  // first alert type (each coin counted once) and "ever had this alert"
  const everTier = (['watch', 'buy', 'ignition', 'pump'] as const).map((t) => {
    const cs = calls.filter((c) => c.events.some((e) => e.tier === t));
    const g = groupBy(cs, () => t)[0];
    return g ?? { key: t, n: 0, hit2x: 0, win: 0, stopped: 0, open: 0, avgPeak: 0, medPeak: 0, rate2x: 0 };
  }).filter((g) => g.n);

  const laneColor = (c: Call) => (c.lane === 'micro' ? 'var(--color-info)' : 'var(--color-gold)');

  return (
    <>
      <PageHeader eyebrow="What the winners had in common" title="Analysis" />
      <div className="card mb-4 border-gold-deep/60 bg-gold/5 p-4 text-sm text-dim">
        <span className="font-medium text-gold-2">Small sample: </span>
        {s.n} coins called, {s.hit2x} hit 2×. Darker bars are groups with fewer than 3 coins — treat them as hints, not rules. These sharpen as more calls close.
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="2× rate by alert type" hint="Coins that ever got this alert, and how many reached 2× from the first call">
          <HBars rows={rateRows(everTier, (k) => TIER_LABEL[k] ?? k)} max={1} />
        </Section>
        <Section title="2× rate by lane and type">
          <HBars
            rows={[
              ...rateRows(groupBy(calls, (c) => c.lane, ['micro', 'quality']), (k) => (k === 'micro' ? 'Micro lane' : 'Quality lane')),
              ...rateRows(groupBy(calls, (c) => c.kind, ['meme', 'utility', 'unknown']), (k) => (k === 'unknown' ? 'Untagged' : k[0].toUpperCase() + k.slice(1))),
            ]}
            max={1}
          />
        </Section>
        <Section title="2× rate by score at first call">
          <HBars rows={rateRows(groupBy(calls, (c) => scoreBucket(c.score), SCORE_ORDER))} max={1} />
        </Section>
        <Section title="2× rate by market cap at call">
          <HBars rows={rateRows(groupBy(calls, (c) => mcapBucket(c.mcapAtCall), MCAP_ORDER))} max={1} />
        </Section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Section title="Score vs peak" hint="Each dot is a coin · blue = micro, gold = quality · dashed line = 2×" className="lg:col-span-3">
          <Scatter
            points={calls
              .filter((c) => c.score != null)
              .map((c) => ({ x: c.score as number, y: c.peakX, color: laneColor(c), label: `$${c.symbol} · score ${c.score} · peak ${c.peakX.toFixed(2)}×`, href: `/calls/${c.token}` }))}
            xLabel="score at first call"
            yLabel="peak multiple"
          />
        </Section>
        <Section title="How high they went" hint="Peak since first alert, number of coins" className="lg:col-span-2">
          <Columns data={peakBuckets.map(([label, f]) => ({ label, value: calls.filter((c) => f(c.peakX)).length }))} highlightFrom={3} height={190} />
        </Section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Winners vs losers" hint="Coins that hit 2× against closed coins that never did">
          <Compare calls={calls} />
        </Section>
        <Section title="2× rate by ETH trend at call" hint="Is the chain's base asset helping or hurting?">
          <HBars rows={rateRows(groupBy(calls.filter((c) => c.ethTrend), (c) => c.ethTrend as string), (k) => `ETH ${k}`)} max={1} />
        </Section>
      </div>
    </>
  );
}
