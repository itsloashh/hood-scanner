import Link from 'next/link';
import { loadHealth, loadMacro, loadOpps, loadUniverse, type Row } from '@/lib/stocks';
import { NotReady, StockRow, Tag, money, pctS } from '@/components/stock-ui';
import { PageHeader, Pill, Section, Stat } from '@/components/ui';
import { ago, pct } from '@/lib/format';

export const revalidate = 300;
export const metadata = { title: 'Stocks · Hood Desk' };

const ROT_TONE: Record<string, 'up' | 'gold' | 'warn' | 'down'> = { leading: 'up', improving: 'gold', weakening: 'warn', lagging: 'down' };

export default async function StocksPage({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const [uni, opps, macro, health, sp] = await Promise.all([loadUniverse(), loadOpps(), loadMacro(), loadHealth(), searchParams]);
  if (!uni.rows.length || !opps) return <><PageHeader eyebrow="US + Canada · research, not advice" title="Stocks" /><NotReady /></>;
  const byId = new Map(uni.rows.map((r) => [r.id, r]));
  const pick = (ids: string[]) => ids.map((i) => byId.get(i)).filter((r): r is Row => !!r);
  const profile = ['value', 'growth', 'dividend'].includes(sp.p ?? '') ? sp.p! : 'all';
  const list = profile === 'all' ? pick(opps.top).slice(0, 25) : pick(opps.by_profile[profile] ?? []).slice(0, 25);
  const insiders = uni.rows.filter((r) => r.insider_buyers_90d > 0 && !r.quarantined).sort((a, b) => b.insider_buyers_90d - a.insider_buyers_90d || b.score - a.score).slice(0, 8);
  const inst = uni.rows.filter((r) => r.inst_adds > 0).sort((a, b) => b.inst_adds - a.inst_adds || b.score - a.score).slice(0, 8);
  const micro = pick(opps.experimental_micro).slice(0, 8);
  const counts = { strong: uni.rows.filter((r) => r.score >= 80 && !r.experimental).length, dev: uni.rows.filter((r) => r.score >= 70 && r.score < 80 && !r.experimental).length, watch: uni.rows.filter((r) => r.score >= 60 && r.score < 70 && !r.experimental).length };
  const failing = health ? Object.entries(health.stages).filter(([, v]) => !v.ok) : [];
  const keyMacro = ['DFF', 'V39079', 'DGS10', 'T10Y2Y', 'BAMLH0A0HYM2', 'DCOILWTICO'].map((k) => [k, macro?.readings[k]] as const).filter(([, v]) => v && v.last != null);

  return (
    <>
      <PageHeader eyebrow="US + Canada · research, not advice" title="Stocks">
        <div className="flex flex-wrap gap-2">
          <Pill>{uni.count.toLocaleString()} stocks scored</Pill>
          <Pill tone={failing.length ? 'warn' : 'up'}>Updated {ago(Date.parse(uni.updated))}</Pill>
        </div>
      </PageHeader>

      {failing.length > 0 && (
        <div className="card mb-4 border-warn/40 p-3 text-sm text-warn">
          Last run had problems: {failing.map(([k, v]) => `${k} (${v.error ?? 'failed'})`).join(' · ')}. Affected data is marked stale.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Strong 80+" value={counts.strong} sub="research candidates" tone="gold" />
        <Stat label="Developing 70–79" value={counts.dev} tone="up" />
        <Stat label="Early watch 60–69" value={counts.watch} />
        <Stat label="Insider buying" value={uni.rows.filter((r) => r.insider_buyers_90d > 0).length} sub="names with open-market buys, 90d" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Section
          title="Top research candidates"
          hint="Ranked by opportunity score. Evidence is scored separately — read both."
          className="lg:col-span-2"
          action={<Link href="/stocks/screener" className="text-xs text-gold hover:text-gold-2">Screener →</Link>}
        >
          <div className="no-scrollbar mb-3 flex gap-1.5 overflow-x-auto">
            {['all', 'value', 'growth', 'dividend'].map((p) => (
              <Link key={p} href={p === 'all' ? '/stocks' : `/stocks?p=${p}`} className={`rounded-full border px-3 py-1 text-xs ${profile === p ? 'border-gold bg-gold/10 text-gold-2' : 'border-line-2 text-dim'}`}>
                {p === 'all' ? 'All' : p[0].toUpperCase() + p.slice(1)}
              </Link>
            ))}
          </div>
          <div className="-mx-2 divide-y divide-line/60">
            {list.map((r, i) => (
              <StockRow key={r.id} r={r} rank={i + 1} />
            ))}
            {!list.length && <p className="p-4 text-sm text-dim">Nothing in this lens yet.</p>}
          </div>
        </Section>

        <div className="space-y-4">
          <Section title="Economy" action={<Link href="/stocks/macro" className="text-xs text-gold hover:text-gold-2">All →</Link>}>
            <ul className="space-y-2.5 text-sm">
              {keyMacro.map(([k, v]) => (
                <li key={k} className="flex items-center justify-between gap-3">
                  <span className="text-dim">{v!.label}</span>
                  <span className="flex items-center gap-2">
                    <span className="num">{v!.last!.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    <span className={v!.reading === 'positive' ? 'text-up' : v!.reading === 'negative' ? 'text-down' : 'text-faint'}>{v!.direction === 'up' ? '↑' : v!.direction === 'down' ? '↓' : '→'}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Sector rotation" hint="vs S&P 500, 1 and 3 months">
            <ul className="space-y-2 text-sm">
              {Object.entries(opps.rotation)
                .sort((a, b) => b[1].rel_1m - a[1].rel_1m)
                .map(([s, v]) => (
                  <li key={s} className="flex items-center justify-between gap-2">
                    <span className="truncate text-dim">{s}</span>
                    <span className="flex items-center gap-2">
                      <span className="num text-xs">{pctS(v.rel_1m, 1)}</span>
                      <Tag tone={ROT_TONE[v.state]}>{v.state}</Tag>
                    </span>
                  </li>
                ))}
            </ul>
          </Section>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Insider buying" hint="Open-market purchases by officers and directors (Form 4) — not awards, exercises or plan trades">
          <div className="-mx-2 divide-y divide-line/60">
            {insiders.map((r) => <StockRow key={r.id} r={r} />)}
            {!insiders.length && <p className="p-2 text-sm text-dim">No qualifying insider purchases in the last 90 days.</p>}
          </div>
        </Section>
        <Section title="Tracked managers adding" hint="13F quarter-end holdings, filed up to 45 days later — not live trades">
          <div className="-mx-2 divide-y divide-line/60">
            {inst.map((r) => <StockRow key={r.id} r={r} />)}
            {!inst.length && <p className="p-2 text-sm text-dim">No 13F additions mapped yet (the 13F sweep runs weekly).</p>}
          </div>
        </Section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="ETFs" hint="Price and distributions only — fees, flows and holdings have no free source">
          <div className="scroll-x">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="text-left text-xs text-faint">
                <tr className="border-b border-line">
                  <th className="py-2 font-medium">ETF</th>
                  <th className="py-2 text-right font-medium">1y total</th>
                  <th className="py-2 text-right font-medium">Yield</th>
                  <th className="py-2 text-right font-medium">Max DD</th>
                </tr>
              </thead>
              <tbody>
                {opps.etfs.filter((e) => e.available !== false).slice(0, 12).map((e) => (
                  <tr key={e.ticker} className="border-b border-line/60 last:border-0">
                    <td className="py-2">
                      <span className="font-medium">{e.ticker}</span> <span className="text-xs text-faint">{e.label}</span>
                      {e.nav_erosion && <Tag tone="warn">NAV erosion?</Tag>}
                    </td>
                    <td className={`num py-2 text-right ${(e.total_return_1y ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>{pctS(e.total_return_1y)}</td>
                    <td className="num py-2 text-right text-dim">{e.yield != null ? pct(e.yield, 1) : '—'}</td>
                    <td className="num py-2 text-right text-dim">{e.max_dd_1y != null ? pct(e.max_dd_1y) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title="Microcaps (experimental)" hint="Under $300M. Kept out of the main rankings on purpose.">
          <div className="-mx-2 divide-y divide-line/60">
            {micro.map((r) => <StockRow key={r.id} r={r} />)}
            {!micro.length && <p className="p-2 text-sm text-dim">None yet.</p>}
          </div>
        </Section>
      </div>
      <p className="mt-6 text-xs text-faint">
        Prices are delayed daily closes. Financials come from SEC filings. Scores are deterministic (method v{opps.score_version}); every point is explained on the stock’s page. Research candidates — not buy instructions.
      </p>
    </>
  );
}
