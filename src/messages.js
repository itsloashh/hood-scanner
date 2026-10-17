// Message formatting for alerts, trade updates and the daily digest.
import { CONFIG } from '../config.js';

export const usd = (v) => {
  if (v == null || Number.isNaN(v)) return '—';
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(2)}`;
};
export const px = (v) => (v == null ? '—' : v >= 1 ? `$${v.toFixed(4)}` : `$${v.toPrecision(3)}`);
const pct = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const fmtN = (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const chartUrl = (pool) => `https://www.geckoterminal.com/${CONFIG.network}/pools/${pool}`;
const tokenUrl = (t) => `https://robinhoodchain.blockscout.com/token/${t}`;

function communityLine(cm) {
  if (!cm) return null;
  const bits = [];
  if (cm.x) bits.push(`X @${cm.x}${cm.xShared ? ' ⚠ reused' : ''}`);
  if (cm.tg) bits.push(`TG @${cm.tg}${cm.tgMembers != null ? ` (${fmtN(cm.tgMembers)} members)` : ''}`);
  if (cm.sentimentPos != null) bits.push(`GT votes ${cm.sentimentPos.toFixed(0)}% 👍`);
  if (cm.gtScore != null) bits.push(`GT score ${cm.gtScore.toFixed(0)}`);
  return bits.length ? `Community: ${bits.join(' · ')}` : null;
}

export function alertMessage(c) {
  const { tier, pool, score, conc, chart, plan, rotation, narratives, holdersCount, holderChangePct, age, warnings, regime, paperOpened, community } = c;
  const head =
    tier === 'buy'
      ? `🟢 BUY ZONE — $${pool.baseToken.symbol}  (score ${score.total}/100)`
      : `👀 WATCH — $${pool.baseToken.symbol}  (score ${score.total}/100, not in buy zone yet)`;
  const lines = [
    head,
    narratives.length ? `Narrative: ${narratives.join(', ')}${rotation.active ? `  · rotation ✓ (${rotation.leader} ${pct(rotation.leaderChange)} 24h)` : ''}` : null,
    `MC ${usd(pool.marketCap)}${pool.marketCapIsFdv ? ' (FDV)' : ''} · Liq ${usd(pool.liquidityUsd)} · Age ${Math.floor(age)}d`,
    `Holders ${holdersCount}${holderChangePct != null ? ` (${pct(holderChangePct, 1)} 3d)` : ''} · Top10 ${conc.top10Pct.toFixed(1)}%${conc.source === 'estimate' ? ' (est.)' : ''} · Top1 ${conc.top1Pct != null ? `${conc.top1Pct.toFixed(1)}%` : '—'}`,
    communityLine(community),
    chart
      ? `From ATH ${chart.drawdownPct != null ? `−${chart.drawdownPct.toFixed(0)}%` : '—'} · 7d range ${chart.baseRange ? `${chart.baseRange.toFixed(2)}×` : '—'} · lows ${chart.lowsHolding ? 'holding' : 'not holding'} · vol ${score.volRatio ? `${score.volRatio.toFixed(1)}×` : '—'} avg`
      : null,
    `24h: ${pool.buyers24h} buyers / ${pool.sellers24h} sellers · price ${pct(pool.change.h24)}`,
    `Score: community ${score.parts.community} · conviction ${score.parts.conviction} · distribution ${score.parts.distribution} · structure ${score.parts.structure} · awakening ${score.parts.awakening} · liq ${score.parts.liquidity} · narrative ${score.parts.narrative}`,
    '',
    tier === 'buy' ? `PLAN  entry ${px(plan.entry)} · stop ${px(plan.stop)} (${CONFIG.paper.stopLossPct}%)` : `If it hits the buy zone, plan would be: stop ${px(plan.stop)} · 3x ${px(plan.takeProfits[0].price)}`,
    tier === 'buy' ? `      ${plan.takeProfits.map((t) => `${t.x}x ${px(t.price)} sell ${t.sell * 100}%`).join(' · ')} · runner ${CONFIG.paper.runnerTargetX}x` : null,
    paperOpened ? `📝 Paper position opened: ${usd(paperOpened.sizeUsd)}` : null,
    regime.state !== 'neutral' ? `Market: ${regime.state}` : null,
    warnings.length ? `⚠ ${warnings.join(' · ')}` : null,
    '',
    `Chart: ${chartUrl(pool.poolAddress)}`,
    `Token: ${tokenUrl(pool.baseToken.address)}`,
    community?.x ? `X: https://x.com/${community.x}` : null,
    `CA: ${pool.baseToken.address}`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

export function tradeMessage(ev) {
  if (ev.type === 'sell') {
    return `📝 Paper $${ev.pos.symbol}: sold ${(ev.fraction * 100).toFixed(0)}% at ${px(ev.price)} — ${ev.why} (+${usd(ev.proceeds)} back)`;
  }
  const r = ev.record;
  const icon = r.pnl >= 0 ? '✅' : '❌';
  return `${icon} Paper $${r.symbol} closed: ${usd(r.sizeUsd)} → ${usd(r.realized)} (${r.multiple.toFixed(2)}×, ${r.pnl >= 0 ? '+' : ''}${usd(r.pnl)})`;
}

export function digestMessage({ paper, eq, stats, regime, funnel, buy24h, watch24h }) {
  const start = CONFIG.paper.startingBankroll;
  const top = Object.entries(funnel.reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([r, n]) => `  • ${r}: ${n}`);
  const lines = [
    `☀️ HOOD SCANNER daily`,
    `Paper bankroll: ${usd(eq)} (started ${usd(start)}, ${pct(((eq - start) / start) * 100, 1)})`,
    `Cash ${usd(paper.cash)} · open ${paper.positions.length}/${CONFIG.paper.maxOpen}`,
    ...paper.positions.map(
      (p) => `  • $${p.symbol}: ${((p.lastPrice / p.entryPrice) || 0).toFixed(2)}× · ${p.tpHit[0] ? 'TP1 hit, riding runner' : 'waiting'}`
    ),
    stats.trades
      ? `Closed: ${stats.trades} · win rate ${(stats.winRate * 100).toFixed(0)}% · hit 3x ${stats.hit3x} · avg ${stats.avgMultiple.toFixed(2)}×`
      : 'Closed trades: none yet',
    `Last 24h: ${buy24h} buy-zone · ${watch24h} watch alerts · ${funnel.runs} scans`,
    `Market regime: ${regime.state}${regime.ratio ? ` (${regime.ratio.toFixed(2)}× median volume)` : ''}`,
    `Funnel (24h avg per scan): ${funnel.scanned} coins → ${funnel.quickPass} quick-pass → ${funnel.deepPass} full-pass`,
    top.length ? `Top reasons coins got cut:\n${top.join('\n')}` : null,
  ];
  return lines.filter((l) => l !== null).join('\n');
}
