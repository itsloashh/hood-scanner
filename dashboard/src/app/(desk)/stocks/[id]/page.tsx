import Link from 'next/link';
import { notFound } from 'next/navigation';
import { COMPONENT_LABEL, loadDetail, PROFILE_LABEL, riskTone, type ComponentScore, type Valued } from '@/lib/stocks';
import { Area } from '@/components/charts';
import { money, num, pctS, ScorePair, Tag } from '@/components/stock-ui';
import { Section } from '@/components/ui';
import { date, pct, price as fmtPrice } from '@/lib/format';

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await loadDetail(decodeURIComponent(id));
  return { title: `${d?.row.ticker ?? 'Stock'} · Hood Desk` };
}

function Comp({ c }: { c: ComponentScore }) {
  const frac = c.max ? c.points / c.max : 0;
  return (
    <div className="border-b border-line/60 py-3 last:border-0">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">{COMPONENT_LABEL[c.name] ?? c.name}</span>
        <span className="num text-dim">
          <span className="text-text">{c.points.toFixed(1)}</span> / {c.max}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel-2">
        <div className="h-full rounded-full bg-gold" style={{ width: `${Math.max(1, frac * 100)}%` }} />
      </div>
      <ul className="mt-2 space-y-0.5 text-xs">
        {c.reasons.map((r) => <li key={r} className="text-up">+ {r}</li>)}
        {c.withheld.map((r) => <li key={r} className="text-dim">− {r}</li>)}
        {c.missing.map((r) => <li key={r} className="text-warn">∅ missing: {r} (no points)</li>)}
        {c.not_applicable.map((r) => <li key={r} className="text-faint">n/a: {r}</li>)}
      </ul>
    </div>
  );
}

function Metric({ label, v, hint }: { label: string; v: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/50 py-2 text-sm last:border-0">
      <span className="text-dim" title={hint}>{label}</span>
      <span className="num text-right">{v}</span>
    </div>
  );
}

const STMT: [string, string][] = [
  ['revenue', 'Revenue'], ['net_income', 'Net income'], ['operating_income', 'Operating income'], ['ocf', 'Operating cash flow'], ['capex', 'Capital spending'],
  ['cash', 'Cash'], ['equity', 'Shareholders’ equity'], ['assets', 'Total assets'], ['shares_outstanding', 'Shares outstanding'], ['dividends_paid', 'Dividends paid'],
];

export default async function StockPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await loadDetail(decodeURIComponent(id));
  if (!d) notFound();
  const r = d.row;
  const m = d.metrics as Record<string, number | null>;
  const best = d.results[d.best_profile];
  const cik = d.security.cik;
  const fs = d.statements;
  const secLink = (accn?: string) => (accn && cik ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, '')}/${accn}-index.htm` : undefined);

  return (
    <>
      <Link href="/stocks" className="mb-4 inline-block text-sm text-dim hover:text-text">← Stocks</Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow mb-1.5">
            {r.exchange} · {r.country} · {r.sector ?? '—'} · {r.cap ?? '?'} cap {r.experimental && '· experimental microcap'}
          </div>
          <h1 className="display text-3xl lg:text-4xl">
            {r.ticker} <span className="text-xl text-dim lg:text-2xl">{r.name}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="num text-lg">{r.currency === 'CAD' ? 'C' : ''}{fmtPrice(r.price)}</span>
            <span className="text-xs text-faint">{r.currency} · delayed close {r.price_date}</span>
            <Tag tone="gold">{best.class}</Tag>
            <Tag>{PROFILE_LABEL[d.best_profile]} lens</Tag>
            <span className={`text-sm ${riskTone(d.risk.label)}`}>{d.risk.label} risk</span>
            {d.security.listings.length > 1 && <Tag tone="info">also {d.security.listings.slice(1).map((l) => l.ticker).join(', ')}</Tag>}
          </div>
        </div>
        <ScorePair score={r.score} confidence={r.confidence} size="lg" />
      </div>

      {(d.risk.quarantine.length > 0 || best.caps.length > 0) && (
        <div className="card mb-4 border-down/40 p-4 text-sm">
          {d.risk.quarantine.map((q) => <div key={q} className="text-down">Quarantined: {q}</div>)}
          {best.caps.map((c) => <div key={c} className="text-warn">{c}</div>)}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Why it scores this way" hint={`Score method v${best.version} · every point traced to a reason`} className="lg:col-span-2">
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            {Object.values(d.results).map((p) => (
              <span key={p.profile} className={`rounded-full border px-2.5 py-1 ${p.profile === d.best_profile ? 'border-gold text-gold-2' : 'border-line-2 text-dim'}`}>
                {PROFILE_LABEL[p.profile]} {p.score.toFixed(0)}
              </span>
            ))}
          </div>
          {Object.values(best.components).map((c) => <Comp key={c.name} c={c} />)}
        </Section>

        <div className="space-y-4">
          <Section title="Evidence confidence" hint="How complete and verified the data is — separate from the score">
            <div className="num mb-2 text-3xl">{d.confidence.confidence}<span className="text-base text-faint">/100</span></div>
            <ul className="space-y-1 text-xs text-dim">{d.confidence.notes.map((n) => <li key={n}>• {n}</li>)}</ul>
          </Section>
          <Section title="Model range" hint={d.scenarios.available ? `${d.scenarios.method} · ${d.scenarios.horizon}` : undefined}>
            {d.scenarios.available ? (
              <>
                <div className="grid grid-cols-3 gap-2 text-center">
                  {(['bear', 'base', 'bull'] as const).map((k) => (
                    <div key={k} className="rounded-lg bg-panel-2 p-2">
                      <div className="text-[10px] uppercase tracking-wider text-faint">{k}</div>
                      <div className="num text-sm">{money(d.scenarios[k] ?? null)}</div>
                      <div className={`num text-xs ${((d.scenarios[k] ?? 0) / (r.mcap || 1) - 1) >= 0 ? 'text-up' : 'text-down'}`}>{pctS((d.scenarios[k] ?? 0) / (r.mcap || 1) - 1)}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-dim">
                  {(d.scenarios.downside_bear ?? 0) <= 0
                    ? 'Even the bear case is above today’s value (no modeled downside).'
                    : <>Reward/risk {d.scenarios.reward_risk != null ? `${d.scenarios.reward_risk.toFixed(1)} : 1` : '—'} {d.scenarios.reward_risk != null && d.scenarios.reward_risk < 2 && '(below the 2:1 target)'}</>}
                </p>
                <ul className="mt-2 space-y-0.5 text-xs text-faint">
                  {d.scenarios.assumptions?.map((a) => <li key={a}>• {a}</li>)}
                  {d.scenarios.invalidation?.map((a) => <li key={a}>✕ thesis breaks if {a}</li>)}
                </ul>
              </>
            ) : (
              <p className="text-sm text-dim">Unavailable — {d.scenarios.why}. No estimate is invented.</p>
            )}
          </Section>
          {d.risk.review.length > 0 && (
            <Section title="Flags for review">
              <ul className="space-y-1 text-sm text-warn">{d.risk.review.map((x) => <li key={x}>• {x}</li>)}</ul>
            </Section>
          )}
        </div>
      </div>

      <Section title="Price, last 12 months" hint="Delayed daily closes" className="mt-4">
        <Area points={d.chart.map(([t, c]) => [Date.parse(t), c] as [number, number])} height={150} fmt={(v) => fmtPrice(v)} />
      </Section>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Section title="Valuation">
          <Metric label="Market cap (USD)" v={money(m.mcap)} />
          <Metric label="P/E (TTM)" v={num(m.pe)} />
          <Metric label="P/E 5-yr avg" v={num(d.history_multiples?.pe_5y)} />
          <Metric label="EV/EBITDA" v={num(m.ev_ebitda)} />
          <Metric label="P/S" v={num(m.ps)} />
          <Metric label="P/B" v={num(m.pb)} />
          <Metric label="FCF yield" v={m.fcf_yield != null ? pct(m.fcf_yield, 1) : '—'} />
          <Metric label="Off 52-week high" v={r.off_high != null ? pct(r.off_high) : '—'} />
          <Metric label="Forward P/E" v="n/a" hint="No free consensus estimates" />
        </Section>
        <Section title="Health">
          <Metric label="Debt / equity" v={num(m.debt_to_equity, 2)} />
          <Metric label="Net debt / EBITDA" v={num(m.net_debt_ebitda)} />
          <Metric label="Interest coverage" v={m.interest_coverage != null ? `${num(m.interest_coverage)}×` : '—'} />
          <Metric label="Current ratio" v={num(m.current_ratio, 2)} />
          <Metric label="ROE" v={m.roe != null ? pct(m.roe) : '—'} />
          <Metric label="ROIC (21% tax assumed)" v={m.roic != null ? pct(m.roic) : '—'} />
          <Metric label="Share count, 1 yr" v={pctS(m.dilution_1y, 1)} />
          {m.cash_runway_months != null && <Metric label="Cash runway" v={`${num(m.cash_runway_months, 0)} months`} />}
        </Section>
        <Section title="Growth">
          <Metric label="Revenue y/y" v={pctS(m.rev_growth)} />
          <Metric label="EPS y/y" v={pctS(m.eps_growth)} />
          <Metric label="FCF y/y" v={pctS(m.fcf_growth)} />
          <Metric label="Gross margin" v={m.gross_margin != null ? pct(m.gross_margin) : '—'} />
          <Metric label="Operating margin" v={m.op_margin != null ? `${pct(m.op_margin)} (was ${m.op_margin_prev != null ? pct(m.op_margin_prev) : '—'})` : '—'} />
          <Metric label="Dividend yield (TTM)" v={d.dividends.yield != null ? pct(d.dividends.yield, 2) : d.dividends.why ?? '—'} />
          <Metric label="Years of distributions" v={d.dividends.years_paid ?? '—'} />
          {d.dividends.cuts && d.dividends.cuts.length > 0 && <Metric label="Cuts" v={d.dividends.cuts.join(', ')} />}
        </Section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Insider activity (Form 4)" hint={`Open-market purchases only · ${d.insider.buyers_90d} buyer(s) in 90 days · sales ${money(d.insider.sells_value_90d)}`}>
          {d.insider.buys.length ? (
            <ul className="divide-y divide-line/60 text-sm">
              {d.insider.buys.map((b, i) => (
                <li key={i} className="py-2">
                  <div className="flex justify-between gap-3">
                    <span>{b.insider} <span className="text-xs text-faint">{b.role}</span></span>
                    <span className="num text-up">{money(b.value)}</span>
                  </div>
                  <div className="text-xs text-faint">
                    {b.shares.toLocaleString()} sh @ ${b.price.toFixed(2)} · traded {b.date} · filed {b.filed} · <a href={b.url} target="_blank" rel="noreferrer" className="text-gold">Form 4 ↗</a>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-dim">No open-market insider purchases in the last 90 days.</p>
          )}
        </Section>
        <Section title="Institutional (13F, 13D/13G)" hint="13F = quarter-end snapshot filed up to 45 days later, never a live trade">
          {d.institutional.length || d.holders_13dg.length ? (
            <ul className="space-y-2 text-sm">
              {d.institutional.map((c, i) => (
                <li key={i} className={c.change === 'new' || c.change === 'increase' ? 'text-up' : c.change === 'unchanged' ? 'text-dim' : 'text-down'}>
                  {c.text} · <a href={c.source} target="_blank" rel="noreferrer" className="text-gold">filing ↗</a>
                </li>
              ))}
              {d.holders_13dg.map((h, i) => (
                <li key={`h${i}`} className="text-dim">{h.form} filed {h.filed} · <a href={h.url} target="_blank" rel="noreferrer" className="text-gold">filing ↗</a></li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-dim">No tracked manager reports this stock, and no 5%+ ownership filings in 90 days.</p>
          )}
        </Section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Filed events (8-K)" hint="Item types from the filing index — details are in each filing">
          {d.events.length ? (
            <ul className="space-y-2 text-sm">
              {d.events.map((e, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span>{e.item} · {e.text}</span>
                  <a href={e.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-gold">{e.filed} ↗</a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-dim">No 8-K events in the last 90 days.</p>
          )}
        </Section>
        <Section title="Financial statements" hint={`From SEC XBRL · latest filing ${fs?.latest_filed ?? '—'}`}>
          {fs ? (
            <div className="scroll-x">
              <table className="w-full min-w-[380px] text-sm">
                <tbody>
                  {STMT.map(([k, label]) => {
                    const v = fs[k] as Valued | undefined;
                    if (!v || typeof v !== 'object') return null;
                    return (
                      <tr key={k} className="border-b border-line/50 last:border-0">
                        <td className="py-1.5 text-dim">{label}</td>
                        <td className="num py-1.5 text-right">{k === 'shares_outstanding' ? `${(v.value / 1e6).toFixed(1)}M` : money(v.value)}</td>
                        <td className="py-1.5 pl-3 text-right text-xs text-faint">
                          {v.basis ? `${v.basis}, ` : ''}to {v.end} · <a href={secLink(v.accn)} target="_blank" rel="noreferrer" className="text-gold">{v.form} ↗</a>
                          {v.restated && <span className="ml-1 text-warn">restated</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-dim">No verified financial statements (no SEC filings for this listing). Score is capped at 69.</p>
          )}
        </Section>
      </div>

      <Section title="Sources" hint="Every number on this page comes from one of these" className="mt-4">
        <ul className="space-y-1.5 text-xs">
          {d.sources.map((s, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2">
              <Tag tone={s.reliability === 'primary' ? 'up' : 'dim'}>{s.reliability}</Tag>
              <span className="text-dim">{s.field}</span>
              <a href={s.url} target="_blank" rel="noreferrer" className="text-gold">{s.provider} ↗</a>
              {s.publication_date && <span className="text-faint">filed {s.publication_date}</span>}
              {s.reporting_period && <span className="text-faint">period {s.reporting_period}</span>}
              <span className="text-faint">retrieved {date(Date.parse(s.retrieved))}</span>
            </li>
          ))}
        </ul>
      </Section>
      <p className="mt-6 text-xs text-faint">Research candidate — not a buy instruction. Data: SEC EDGAR (primary), Yahoo delayed prices, FRED and Bank of Canada.</p>
    </>
  );
}
