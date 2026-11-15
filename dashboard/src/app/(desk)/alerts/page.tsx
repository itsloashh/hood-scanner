import Link from 'next/link';
import { loadAll, loadCoinRules } from '@/lib/data';
import { loadStockAlerts, loadStockRules, loadUniverse } from '@/lib/stocks';
import { PageHeader, Section, TIER_META } from '@/components/ui';
import { ago, date, price, usd } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Alerts · Hood Desk' };

type Item = { at: number; market: 'coin' | 'stock'; title: string; sub: string; href: string; tone: string; tag: string };

const STOCK_TAG: Record<string, [string, string]> = {
  opportunity: ['Opportunity', 'text-gold-2 border-gold/40 bg-gold/10'],
  insider: ['Insider buy', 'text-up border-up/40 bg-up/10'],
  institutional: ['13F add', 'text-info border-info/40 bg-info/10'],
  catalyst: ['Catalyst', 'text-violet border-violet/40 bg-violet/10'],
  risk: ['Risk', 'text-down border-down/40 bg-down/10'],
};

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const [{ state }, uni, salerts, crules, srules, sp] = await Promise.all([loadAll(), loadUniverse(), loadStockAlerts(), loadCoinRules(), loadStockRules(), searchParams]);
  const tick = new Map(uni.rows.map((r) => [r.id, r.ticker]));
  const items: Item[] = [];
  for (const e of state.scorecard) {
    const m = TIER_META[e.tier];
    items.push({
      at: e.at, market: 'coin', title: `$${e.symbol}`, href: `/coins/${e.token}`, tag: m?.label ?? e.tier, tone: m?.cls ?? '',
      sub: `${price(e.price)}${e.score != null ? ` · score ${e.score}` : ''}${e.mcap ? ` · ${usd(e.mcap)} mcap` : ''}${e.zones?.swing ? ` · stop ${price(e.zones.swing.stop)} · TP1 ${price(e.zones.swing.tps[0]?.p)}` : ''}`,
    });
  }
  for (const [token, c] of Object.entries(state.called ?? {})) {
    for (const [k, at] of Object.entries(c.milestones ?? {})) {
      items.push({ at, market: 'coin', title: `$${c.symbol}`, href: `/coins/${token}`, tag: k === 'half' ? 'Fell 50%' : `Hit ${k.replace('x', '')}×`, tone: k === 'half' ? 'text-down border-down/40 bg-down/10' : 'text-up border-up/40 bg-up/10', sub: 'milestone since the first call' });
    }
  }
  for (const a of salerts?.log ?? []) {
    if (a.delivery_status !== 'sent') continue;
    const [label, tone] = STOCK_TAG[a.alert_type] ?? [a.alert_type, ''];
    const t = a.security_id ? tick.get(a.security_id) ?? a.security_id : '—';
    items.push({ at: Date.parse(a.created_at), market: 'stock', title: t, href: a.security_id ? `/stocks/${encodeURIComponent(a.security_id)}` : '/stocks', tag: label, tone, sub: `${a.trigger_event ?? ''}${a.score != null ? ` · score ${Math.round(a.score)}` : ''}` });
  }
  const m = sp.m === 'coin' || sp.m === 'stock' ? sp.m : 'all';
  const list = items.filter((i) => m === 'all' || i.market === m).sort((a, b) => b.at - a.at).slice(0, 150);
  const today = items.filter((i) => Date.now() - i.at < 86_400_000);

  return (
    <>
      <PageHeader eyebrow="Everything the bot sent to Telegram" title="Alerts" />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(['all', 'coin', 'stock'] as const).map((k) => (
          <Link key={k} href={k === 'all' ? '/alerts' : `/alerts?m=${k}`} className={`btn px-3 py-1.5 ${m === k ? 'btn-on' : ''}`}>
            {k === 'all' ? 'All' : k === 'coin' ? 'Coins' : 'Stocks'}
          </Link>
        ))}
        <span className="ml-auto text-sm text-faint">
          {today.length} in the last 24h · {today.filter((i) => i.market === 'coin').length} coin · {today.filter((i) => i.market === 'stock').length} stock
        </span>
      </div>

      <div className="grid gap-4 @4xl:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-2">
          {list.map((i, n) => (
            <Link key={n} href={i.href} className="card tap flex items-center gap-3 p-3.5">
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${i.tone}`}>{i.tag}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{i.title}</span>
                  <span className="text-[10px] uppercase tracking-wider text-faint">{i.market}</span>
                </div>
                <div className="num truncate text-xs text-dim">{i.sub}</div>
              </div>
              <div className="shrink-0 text-right text-xs text-faint">
                <div>{ago(i.at)}</div>
                <div className="hidden @2xl:block">{date(i.at)}</div>
              </div>
            </Link>
          ))}
          {!list.length && <div className="card p-6 text-center text-sm text-dim">No alerts yet.</div>}
        </div>

        <div className="min-w-0 space-y-4">
          <Section title="Coin alert rules" hint={crules ? `live from the bot · ${ago(Date.parse(crules.updated))}` : 'published after the next scan'}>
            {crules ? (
              <ul className="space-y-2 text-sm text-dim">
                <li><b className="text-text">Buy zone</b> at score {crules.buyScore}+, <b className="text-text">Watch</b> at {crules.watchScore}+ (bar moves {crules.regimeAdjust.riskOn} when the market is hot, +{crules.regimeAdjust.riskOff} when cold).</li>
                <li><b className="text-text">Lanes:</b> micro up to {usd(crules.lanes.microMaxMarketCap)}; quality needs {crules.lanes.quality.minHolders.toLocaleString()}+ holders, {usd(crules.lanes.quality.minLiquidityUsd)}+ liquidity and {crules.lanes.quality.minDrawdownPct}–{crules.lanes.quality.maxDrawdownPct}% off its high.</li>
                {crules.profile.enabled && <li><b className="text-text">Winner profile</b> (micro): {crules.profile.minBuyers24h}+ buyers/day, buyers ≥ sellers, volume {crules.profile.minVolRatio}×+ its average, 24h move {crules.profile.change24h[0]} to +{crules.profile.change24h[1]}%.</li>}
                <li><b className="text-text">Ignition:</b> hourly volume {crules.ignition.minVolMultiple}×+ normal over {crules.ignition.hours}h, price ≤ {crules.ignition.maxPriceAboveBasePct}% above its base; once per {crules.ignition.cooldownHours}h.</li>
                <li><b className="text-text">Pump:</b> +{crules.pump.minChangePct}% in 24h, with a pullback entry plan; once per {crules.pump.cooldownHours}h.</li>
                <li><b className="text-text">Repeats:</b> one full alert per coin, then only the first move into the buy zone and 2×/3×/−50% milestones. Followed (★) coins also get ±{crules.tracking.followScoreJump} score, ±{crules.tracking.followPriceMovePct}% price and a daily check-in. Quiet {crules.tracking.forgetDays} days → fresh alert.</li>
                <li><b className="text-text">Scorecard:</b> a win is {crules.scorecard.winX}× before −{Math.round((1 - crules.scorecard.stopX) * 100)}% within {crules.scorecard.days} days.</li>
                <li><b className="text-text">Zones:</b> every call includes entry, stop, hold and scalp/swing take-profits.</li>
              </ul>
            ) : (
              <p className="text-sm text-dim">The coin bot publishes its rules after its next scan (every 15 minutes).</p>
            )}
          </Section>
          <Section title="Stock alert rules" hint={srules ? `method v${srules.score_version}` : undefined}>
            {srules ? (
              <ul className="space-y-2 text-sm text-dim">
                <li><b className="text-text">Opportunity:</b> score {srules.alert.opportunity_min_score}+ with evidence {srules.alert.opportunity_min_confidence}+; again only on a class upgrade and +{srules.alert.rescore_jump} points.</li>
                <li><b className="text-text">Insider buy:</b> 2+ insiders buying on the open market within 30 days totalling {usd(srules.alert.insider_min_value_usd)}+, or a CEO/CFO buying {usd(srules.alert.insider_min_value_usd)}+. Checked every 2 hours on weekdays.</li>
                <li><b className="text-text">13F add:</b> 2+ of the {srules.managers} tracked funds added, from a 13F filed in the last 2 weeks.</li>
                <li><b className="text-text">Catalyst / risk:</b> new 8-K deals, acquisitions or control changes on names scoring 65+; bankruptcy, delisting or restatement notices on 50+.</li>
                <li><b className="text-text">Universe:</b> {usd(srules.eligibility.min_mcap_usd)}+ market cap, ${srules.eligibility.min_price_usd}+ price, {usd(srules.eligibility.min_adv_usd)}+ daily volume.</li>
                <li><b className="text-text">Limits:</b> at most {srules.alert.max_alerts_per_run} alerts per run; daily digest after the close.</li>
              </ul>
            ) : (
              <p className="text-sm text-dim">Published after the next stock run.</p>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
