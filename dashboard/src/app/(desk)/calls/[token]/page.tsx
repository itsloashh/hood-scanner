import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadAll, poolCandles } from '@/lib/data';
import { buildCalls } from '@/lib/calls';
import { PriceChart } from '@/components/PriceChart';
import { Mult, Outcome, Pill, Section, Stat, TIER_META, TierBadge } from '@/components/ui';
import { date, price, short, usd } from '@/lib/format';

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { state } = await loadAll();
  const sym = state.scorecard.find((e) => e.token === token)?.symbol ?? state.called?.[token]?.symbol;
  return { title: `${sym ? `$${sym}` : 'Coin'} · Hood Desk` };
}

const MILESTONE: Record<string, string> = { x2: 'Reached 2×', x3: 'Reached 3×', half: 'Fell 50%' };

export default async function CoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { state, prices, prefs } = await loadAll();
  const c = buildCalls(state, prices, prefs).find((x) => x.token === token.toLowerCase() || x.token === token);
  if (!c) notFound();

  const candles = c.pool ? await poolCandles(c.pool, c.firstAt - 5 * 86_400_000) : [];
  const timeline = [
    ...c.events.map((e) => ({ at: e.at, kind: 'alert' as const, tier: e.tier, text: `${TIER_META[e.tier]?.label ?? e.tier} alert`, detail: `${price(e.price)}${e.score != null ? ` · score ${e.score}` : ''}` })),
    ...Object.entries(c.milestones).map(([k, at]) => ({ at, kind: 'milestone' as const, tier: null, text: MILESTONE[k] ?? k, detail: '' })),
    ...(c.closedAt ? [{ at: c.closedAt, kind: 'milestone' as const, tier: null, text: c.status === 'win' ? 'Closed as a 3× win' : c.status === 'stopped' ? 'Closed: fell 50%' : 'Tracking ended', detail: '' }] : []),
  ].sort((a, b) => a.at - b.at);

  return (
    <>
      <Link href="/calls" className="mb-4 inline-block text-sm text-dim hover:text-text">
        ← All calls
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-1.5">
            {c.lane} lane · {c.kind}
          </div>
          <h1 className="display flex items-center gap-3 text-4xl">
            ${c.symbol}
            {c.pref === 'follow' && <span className="text-2xl text-gold" title="Followed">★</span>}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <TierBadge tier={c.firstTier} />
            <span className="text-dim">first called {date(c.firstAt)}</span>
            <span className="text-faint">·</span>
            <Outcome c={c} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {c.pool && (
            <a href={`https://www.geckoterminal.com/robinhood/pools/${c.pool}`} target="_blank" rel="noreferrer" className="rounded-lg border border-line-2 px-3 py-2 text-sm text-dim hover:text-text">
              GeckoTerminal ↗
            </a>
          )}
          <a href={`https://robinhoodchain.blockscout.com/token/${c.token}`} target="_blank" rel="noreferrer" className="rounded-lg border border-line-2 px-3 py-2 text-sm text-dim hover:text-text">
            Explorer ↗
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Call price" value={<span className="text-xl">{price(c.firstPrice)}</span>} sub={`mcap ${usd(c.mcapAtCall)}`} />
        <Stat label="Peak" value={<Mult v={c.peakX} strong />} sub="best since first alert" />
        <Stat label="Lowest" value={<Mult v={c.lowX} />} sub="worst since first alert" />
        <Stat label="Now" value={<Mult v={c.nowX} />} sub={`${price(c.nowPrice)} · ${usd(c.nowMcap)}`} />
        <Stat label="Score" value={c.bestScore ?? '—'} sub={c.score != null && c.score !== c.bestScore ? `${c.score} at first call` : 'best score'} />
        <Stat label="Liquidity" value={<span className="text-xl">{usd(c.nowLiq)}</span>} sub={c.ethTrend ? `ETH was ${c.ethTrend} at call` : undefined} />
      </div>

      <Section title="Price since the call" hint="Dashed lines are 2×, 3× and −50% from the first call price" className="mt-4">
        {candles.length > 2 ? (
          <PriceChart
            candles={candles}
            callPrice={c.firstPrice}
            markers={c.events.map((e) => ({ at: e.at, label: TIER_META[e.tier]?.label ?? e.tier, color: TIER_META[e.tier]?.color ?? 'var(--color-dim)' }))}
          />
        ) : (
          <p className="text-sm text-dim">Price history isn’t available for this pool right now (GeckoTerminal may be rate limiting). Try again in a few minutes.</p>
        )}
      </Section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Timeline">
          <ol className="relative space-y-4 border-l border-line pl-5">
            {timeline.map((t, i) => (
              <li key={i} className="relative">
                <span
                  className="absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-ink"
                  style={{ background: t.tier ? TIER_META[t.tier].color : 'var(--color-gold)' }}
                />
                <div className="text-sm font-medium">{t.text}</div>
                <div className="text-xs text-faint">
                  {date(t.at)}
                  {t.detail && ` · ${t.detail}`}
                </div>
              </li>
            ))}
          </ol>
        </Section>
        <Section title="Details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
            <dt className="text-faint">Contract</dt>
            <dd className="num truncate" title={c.token}>
              {short(c.token)}
            </dd>
            <dt className="text-faint">Pool</dt>
            <dd className="num truncate">{c.pool ? short(c.pool) : '—'}</dd>
            <dt className="text-faint">Watch</dt>
            <dd>{date(c.watchAt)}</dd>
            <dt className="text-faint">Buy zone</dt>
            <dd>{date(c.buyAt)}</dd>
            <dt className="text-faint">Ignition</dt>
            <dd>{date(c.ignitionAt)}</dd>
            <dt className="text-faint">Pump</dt>
            <dd>{date(c.pumpAt)}</dd>
            <dt className="text-faint">Your setting</dt>
            <dd>{c.pref === 'follow' ? <Pill tone="gold">Followed</Pill> : c.pref === 'mute' ? <Pill>Muted</Pill> : <span className="text-dim">Default</span>}</dd>
          </dl>
          <p className="mt-4 text-xs text-faint">Follow or mute from the coin’s alert in Telegram.</p>
        </Section>
      </div>
    </>
  );
}
