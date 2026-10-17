// Telegram messages — same data as before, written to be read in 10 seconds.
import { CONFIG } from '../config.js';

// ── formatting helpers ──────────────────────────────────────
export const usd = (v) => {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${sign}$${a.toFixed(2)}`;
};
export const px = (v) => (v == null ? '—' : v >= 1 ? `$${v.toFixed(4)}` : `$${v.toPrecision(3)}`);
const num = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const pctTxt = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}%`);
const bullet = (s) => (s ? `• ${s}` : null);

// verdict word for a score part
function grade(pts, max) {
  const r = max ? pts / max : 0;
  return r >= 0.7 ? 'strong' : r >= 0.4 ? 'decent' : 'weak';
}

function liquidityNote(liq, mcap) {
  const r = mcap ? liq / mcap : 0;
  if (r >= 0.15) return 'deep enough to get in and out easily';
  if (r >= 0.08) return 'okay for a small position';
  return 'thin — keep size small, expect slippage';
}

function spreadNote(top10) {
  if (top10 == null) return 'unknown';
  if (top10 <= 20) return 'well spread out';
  if (top10 <= 30) return 'healthy';
  return 'a bit concentrated';
}

function rangeNote(r) {
  if (r == null) return null;
  if (r <= 1.3) return `Tight sideways base (moved within ${r.toFixed(2)}× over 7 days)`;
  if (r <= 1.6) return `Fairly steady (moved within ${r.toFixed(2)}× over 7 days)`;
  return `Still choppy (moved within ${r.toFixed(2)}× over 7 days)`;
}

function volumeNote(v) {
  if (v == null) return null;
  if (v < 0.7) return `Volume quiet today (${v.toFixed(1)}× its usual volume)`;
  if (v < 1.3) return `Volume normal today (${v.toFixed(1)}× its usual volume)`;
  if (v < 2) return `Volume picking up today (${v.toFixed(1)}× its usual volume)`;
  return `Volume surging today (${v.toFixed(1)}× its usual volume)`;
}

function holderTrendNote(ch) {
  if (ch == null) return 'Holder trend: not enough history yet (needs about a day of scans)';
  if (ch >= 2) return `Holders growing (${pctTxt(ch, 1)} in 3 days) — people are joining`;
  if (ch >= -2) return `Holders steady (${pctTxt(ch, 1)} in 3 days) — the crowd is holding`;
  return `Holders shrinking (${pctTxt(ch, 1)} in 3 days) — people are leaving`;
}

const PART_LABELS = [
  ['community', 'Community', 25],
  ['structure', 'Chart setup', 25],
  ['distribution', 'Wallet spread', 15],
  ['awakening', 'Buyers returning', 15],
  ['conviction', 'Holders holding', 10],
  ['liquidity', 'Liquidity', 5],
  ['narrative', 'Narrative', 5],
];

const chartUrl = (pool) => `https://www.geckoterminal.com/${CONFIG.network}/pools/${pool}`;
const tokenUrl = (t) => `https://robinhoodchain.blockscout.com/token/${t}`;

// ── coin alert ──────────────────────────────────────────────
export function alertMessage(c) {
  const { tier, pool, score, conc, chart, plan, rotation, narratives, holdersCount, holderChangePct, age, warnings, regime, paperOpened, community, flow } = c;
  const sym = pool.baseToken.symbol;
  const p = score.parts;
  const L = [];

  if (tier === 'buy') {
    L.push(`🟢 BUY ZONE · $${sym} — ${score.total}/100`);
    L.push(`Passed every safety check and scored above ${CONFIG.alertScore}. Trade plan below.`);
  } else {
    L.push(`👀 WATCH · $${sym} — ${score.total}/100`);
    L.push(score.buyBlocked
      ? 'Passed the safety checks, but its trading looks bot-driven — watch only, no trade.'
      : `Passed every safety check. ${Math.max(0, CONFIG.alertScore - score.total)} points short of the buy zone (${CONFIG.alertScore}).`);
  }
  if (regime.state !== 'neutral') L.push(regime.state === 'risk-on' ? 'Market is heating up — bar lowered a little.' : 'Market is cooling — bar raised a little.');

  // Size
  L.push('', '💰 SIZE');
  L.push(bullet(`Market cap ${usd(pool.marketCap)}${pool.marketCapIsFdv ? ' (fully diluted)' : ''} · ${Math.floor(age)} days old`));
  L.push(bullet(`Liquidity ${usd(pool.liquidityUsd)} — ${liquidityNote(pool.liquidityUsd, pool.marketCap)}`));
  if (narratives.length) {
    L.push(bullet(`Theme: ${narratives.join(', ')}${rotation.active ? ` — its sector leader $${rotation.leader} is up ${pctTxt(rotation.leaderChange)} today while this one hasn't moved yet` : ''}`));
  }

  // Community
  L.push('', `👥 COMMUNITY — ${grade(p.community, 25)}`);
  L.push(bullet(`${num(holdersCount)} holders · ${pool.buyers24h} people bought and ${pool.sellers24h} sold in the last 24h`));
  if (community?.tg) L.push(bullet(`Telegram @${community.tg}${community.tgMembers != null ? ` — ${num(community.tgMembers)} members` : ''}`));
  if (community?.x) L.push(bullet(`X @${community.x}${community.xShared ? ' — ⚠️ this handle is also linked to another token' : ''}`));
  const gtBits = [];
  if (community?.gtScore != null) gtBits.push(`trust score ${Math.round(community.gtScore)}/100`);
  if (community?.sentimentPos != null) gtBits.push(community.sentimentPos < 30 ? `⚠️ only ${Math.round(community.sentimentPos)}% of voters positive` : `${Math.round(community.sentimentPos)}% of voters positive`);
  if (gtBits.length) L.push(bullet(`GeckoTerminal: ${gtBits.join(', ')}`));
  L.push(bullet(holderTrendNote(holderChangePct)));

  // Wallets
  L.push('', `🐋 WALLET SPREAD — ${spreadNote(conc.top10Pct)}`);
  L.push(bullet(`Top 10 wallets hold ${conc.top10Pct.toFixed(1)}%${conc.source === 'estimate' ? ' (estimated)' : ''}`));
  L.push(bullet(conc.top1Pct != null ? `Biggest single wallet holds ${conc.top1Pct.toFixed(1)}%` : 'Biggest single wallet: not checked this time'));

  // Who's buying (trade feed)
  if (flow) {
    const net = flow.netFlowUsd;
    L.push('', `🔎 WHO'S BUYING (last ${flow.windowHours}h of trades)`);
    L.push(bullet(`${flow.uniqueBuyers} different wallets bought, ${flow.uniqueSellers} sold — ${net >= 0 ? `${usd(net)} more bought than sold` : `${usd(-net)} more sold than bought`}`));
    L.push(bullet(`Typical buy ${usd(flow.medianBuyUsd)}${flow.whaleBuys ? ` · ${flow.whaleBuys} big buy(s) over ${usd(CONFIG.wallets.whaleBuyUsd)}` : ''}${flow.repeatBuyers ? ` · ${flow.repeatBuyers} wallet(s) buying more than once` : ''}`));
    if (flow.overlap != null) {
      L.push(bullet(flow.washLikely
        ? `🚩 ${Math.round(flow.overlap * 100)}% of wallets are on both sides, ~${flow.tradesPerWallet} trades each — this is churn, not new buyers`
        : `${Math.round(flow.overlap * 100)}% of wallets traded both sides · ~${flow.tradesPerWallet} trades per wallet — looks organic`));
    }
    if (flow.smartBuyers.length) {
      L.push(bullet(`🧠 ${flow.smartBuyers.length} proven wallet(s) bought — wallets with a track record of catching 3x+ runs (+${p.smartMoney} pts)`));
    }
  }

  // Chart
  L.push('', `📈 CHART — ${grade(p.structure, 25)} setup`);
  if (chart) {
    if (chart.drawdownPct != null) L.push(bullet(`Down ${chart.drawdownPct.toFixed(0)}% from its all-time high`));
    L.push(bullet(rangeNote(chart.baseRange)));
    if (chart.lowsHolding != null) L.push(bullet(chart.lowsHolding ? 'Recent lows are holding — no new bottoms' : 'Still making new lows'));
    L.push(bullet(volumeNote(score.volRatio)));
  } else {
    L.push(bullet('Chart data unavailable this scan'));
  }
  L.push(bullet(`Price today: ${pctTxt(pool.change.h24)}`));

  // Score breakdown
  L.push('', `📊 WHY ${score.total}`);
  L.push(PART_LABELS.map(([k, label, max]) => `${label} ${Math.round(p[k])}/${max}`).join(' · '));
  const extras = [];
  if (p.smartMoney) extras.push(`Smart money +${p.smartMoney}`);
  if (p.bundlePenalty) extras.push(`Bundled buys ${p.bundlePenalty}`);
  if (p.washPenalty) extras.push(`Wash trading ${p.washPenalty}`);
  if (p.inflatedHoldersPenalty) extras.push(`Padded holder count ${p.inflatedHoldersPenalty}`);
  if (extras.length) L.push(extras.join(' · '));

  // Risks
  if (warnings.length) {
    L.push('', '⚠️ HEADS UP');
    for (const wn of warnings) L.push(bullet(wn));
  }

  // Plan
  L.push('', '🎯 PLAN');
  if (tier === 'buy') {
    L.push(bullet(`Entry around ${px(plan.entry)}`));
    L.push(bullet(`Stop: ${px(plan.stop)} (${CONFIG.paper.stopLossPct}%)`));
    for (const t of plan.takeProfits) L.push(bullet(`${t.x}x at ${px(t.price)} → sell ${t.sell * 100}%`));
    L.push(bullet(`Let the rest ride to ${CONFIG.paper.runnerTargetX}x, or exit if it drops ${CONFIG.paper.trailFromPeakPct}% from its peak`));
    if (paperOpened) L.push(`📝 Paper trade opened with ${usd(paperOpened.sizeUsd)}`);
  } else {
    L.push(bullet(`Not a buy yet. If it reaches the buy zone: stop ${px(plan.stop)}, first target ${px(plan.takeProfits[0].price)} (3x)`));
  }

  // Links
  L.push('', '🔗 LINKS');
  L.push(`Chart: ${chartUrl(pool.poolAddress)}`);
  L.push(`Holders: ${tokenUrl(pool.baseToken.address)}`);
  if (community?.x) L.push(`X: https://x.com/${community.x}`);
  L.push(`CA: ${pool.baseToken.address}`);

  return L.filter((l) => l !== null).join('\n');
}

// ── paper trade updates ─────────────────────────────────────
export function tradeMessage(ev) {
  if (ev.type === 'sell') {
    return `📝 Paper trade · $${ev.pos.symbol}\nSold ${(ev.fraction * 100).toFixed(0)}% at ${px(ev.price)} — ${ev.why}.\n${usd(ev.proceeds)} back in the bankroll.`;
  }
  const r = ev.record;
  const won = r.pnl >= 0;
  return `${won ? '✅' : '❌'} Paper trade closed · $${r.symbol}\nPut in ${usd(r.sizeUsd)}, got back ${usd(r.realized)} — ${won ? 'profit' : 'loss'} of ${usd(Math.abs(r.pnl))} (${r.multiple.toFixed(2)}×).`;
}

// ── daily summary ───────────────────────────────────────────
export function digestMessage({ paper, eq, stats, regime, funnel, buy24h, watch24h, walletStats }) {
  const start = CONFIG.paper.startingBankroll;
  const change = ((eq - start) / start) * 100;
  const L = [];
  L.push('☀️ HOOD SCANNER — daily summary');

  L.push('', '💵 PAPER BANKROLL');
  L.push(bullet(`${usd(eq)} now (started with ${usd(start)}, ${pctTxt(change, 1)})`));
  L.push(bullet(`${usd(paper.cash)} cash · ${paper.positions.length} of ${CONFIG.paper.maxOpen} trades open`));
  for (const p of paper.positions) {
    const x = p.entryPrice ? p.lastPrice / p.entryPrice : 0;
    L.push(`   – $${p.symbol}: ${x.toFixed(2)}× since entry${p.tpHit[0] ? ' · first target hit, riding the rest' : ''}`);
  }
  L.push(bullet(stats.trades
    ? `${stats.trades} closed trades · ${(stats.winRate * 100).toFixed(0)}% winners · ${stats.hit3x} hit 3x · average ${stats.avgMultiple.toFixed(2)}×`
    : 'No closed trades yet'));

  L.push('', '🔔 LAST 24 HOURS');
  L.push(bullet(`${buy24h} buy-zone alert(s) · ${watch24h} watch alert(s)`));
  L.push(bullet(`${funnel.runs} scans ran. A typical scan looked at ${funnel.scanned} coins → ${funnel.quickPass} survived the junk filter → ${funnel.deepPass} passed the full safety check`));
  const mood = { 'risk-on': 'heating up', 'risk-off': 'cooling off', neutral: 'normal' }[regime.state] || regime.state;
  L.push(bullet(`Chain-wide trading is ${mood}${regime.ratio ? ` (${regime.ratio.toFixed(2)}× the usual volume)` : ''}`));

  const top = Object.entries(funnel.reasons).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) {
    L.push('', '✂️ WHY COINS GOT CUT (per scan, on average)');
    for (const [r, n] of top) L.push(bullet(`${n} — ${r}`));
  }

  if (walletStats) {
    L.push('', '🧠 WALLET TRACKER');
    L.push(bullet(`Watching ${num(walletStats.tracked)} wallets · ${walletStats.smart} proven "smart" wallets${walletStats.seeded ? ` (${walletStats.seeded} from research)` : ''}`));
    L.push(bullet(`Tracked buys so far: ${walletStats.wins} hit 3x, ${walletStats.losses} didn't, ${walletStats.open} still playing out`));
  }
  return L.filter((l) => l !== null).join('\n');
}
