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

  if (c.headerLines) {
    L.push(...c.headerLines);
  } else if (tier === 'buy') {
    L.push(`🟢 BUY ZONE · $${sym} — ${score.total}/100`);
    L.push(`Passed every safety check and scored above ${CONFIG.alertScore}. Trade plan below.`);
  } else {
    L.push(`👀 WATCH · $${sym} — ${score.total}/100`);
    L.push(score.buyBlocked
      ? `Scored ${score.total}, but ${score.buyBlockedWhy || 'its trading looks bot-driven'} — watch only for now.`
      : `Passed every safety check. ${Math.max(0, CONFIG.alertScore - score.total)} points short of the buy zone (${CONFIG.alertScore}).`);
  }
  if (c.kind === 'utility') L.push(`🛠 UTILITY TOKEN — ${c.kindWhy.join(', ')}. Still judged by the same safety rules.`);
  if (score.lane === 'quality') L.push('🏛 QUALITY LANE — established coin with a real crowd, setting up a possible second leg.');
  else if (score.lane === 'micro') L.push('🧪 MICRO LANE — small survivor bounce. Small size only.');
  if (regime.state !== 'neutral') L.push(regime.state === 'risk-on' ? 'Market is heating up — bar lowered a little.' : 'Market is cooling — bar raised a little.');

  // Size
  L.push('', '💰 SIZE');
  L.push(bullet(`Market cap ${usd(pool.marketCap)}${pool.marketCapIsFdv ? ' (fully diluted)' : ''} · ${age != null ? `${Math.floor(age)} days old` : 'age unknown'}`));
  L.push(bullet(`Liquidity ${usd(pool.liquidityUsd)} — ${liquidityNote(pool.liquidityUsd, pool.marketCap)}`));
  if (pool.marketCap) {
    L.push(bullet(`🎯 Target ${CONFIG.targetMinX}–${CONFIG.targetMaxX}x = ${usd(pool.marketCap * CONFIG.targetMinX)} to ${usd(pool.marketCap * CONFIG.targetMaxX)} market cap`));
  }
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
  if (conc) {
    L.push('', `🐋 WALLET SPREAD — ${spreadNote(conc.top10Pct)}`);
    L.push(bullet(`Top 10 wallets hold ${conc.top10Pct.toFixed(1)}%${conc.source === 'estimate' ? ' (estimated)' : ''}`));
    L.push(bullet(conc.top1Pct != null ? `Biggest single wallet holds ${conc.top1Pct.toFixed(1)}%` : 'Biggest single wallet: not checked this time'));
  } else {
    L.push('', '🐋 WALLET SPREAD — unavailable');
  }

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

  // Burns
  const b = c.burns;
  if (b && (b.burnedPct != null || b.recent)) {
    const burnedTxt = b.burnedPct != null ? `${b.burnedPct.toFixed(1)}% of supply burned` : 'burned share unknown';
    const recentTxt = b.recent ? (b.recent.count ? `${b.recent.count} burn(s) in the last ${CONFIG.burns.recentDays} days — supply is actively shrinking` : `no burns in the last ${CONFIG.burns.recentDays} days`) : null;
    const strong = (b.burnedPct ?? 0) >= CONFIG.burns.bigBurnPct || b.recent?.count > 0;
    L.push('', `🔥 BURNS — ${strong ? 'deflationary' : 'none to speak of'}`);
    L.push(bullet(burnedTxt));
    L.push(bullet(recentTxt));
  }

  // Catalysts
  if (score.catalystWhy?.length) {
    L.push('', '⚡ CATALYSTS');
    for (const why of score.catalystWhy) L.push(bullet(why));
  }

  // Chart
  L.push('', `📈 CHART — ${grade(p.structure, 25)} setup`);
  if (chart) {
    if (chart.drawdownPct != null) L.push(bullet(`Down ${chart.drawdownPct.toFixed(0)}% from its all-time high`));
    L.push(bullet(rangeNote(chart.baseRange)));
    if (chart.lowsHolding != null) L.push(bullet(chart.lowsHolding ? 'Recent lows are holding — no new bottoms' : 'Still making new lows'));
    L.push(bullet(volumeNote(score.volRatio)));
    if (chart.volTrend != null) {
      L.push(bullet(p.quietBase
        ? `🤫 Quiet base: volume has dried up to ${chart.volTrend.toFixed(2)}× while price goes sideways — sellers are exhausted (CASHCAT/FRONG setup). Watching hourly for ignition.`
        : p.absorption
          ? `🧲 Absorption base: volume up ${chart.volTrend.toFixed(2)}× but price won't drop — weak sellers being soaked up by steady buyers (FLORK's 19× setup). Watching hourly for ignition.`
          : `Volume trend ${chart.volTrend.toFixed(2)}× (last 3 days vs the week before)`));
    }
  } else {
    L.push(bullet('Chart data unavailable this scan'));
  }
  L.push(bullet(`Price today: ${pctTxt(pool.change.h24)}`));
  const e = c.eth;
  if (e?.price && /^w?eth$/i.test(pool.quoteToken?.symbol || '')) {
    const own = e.h24 != null && pool.change.h24 != null ? ((1 + pool.change.h24 / 100) / (1 + e.h24 / 100) - 1) * 100 : null;
    L.push(bullet(`Paired with ETH — ETH is ${e.h24 != null ? `${pctTxt(e.h24, 1)} today` : `$${Math.round(e.price)}`}${e.d7 != null ? `, ${pctTxt(e.d7, 1)} this week` : ''}${own != null ? ` → the coin's own move today: ${pctTxt(own)}` : ''}`));
  }

  // Score breakdown
  L.push('', `📊 WHY ${score.total}`);
  L.push(PART_LABELS.map(([k, label, max]) => `${label} ${Math.round(p[k])}/${max}`).join(' · '));
  const extras = [];
  if (p.smartMoney) extras.push(`Smart money +${p.smartMoney}`);
  if (p.burn) extras.push(`Burns +${p.burn}`);
  if (p.quietBase) extras.push(`Quiet base +${Math.round(p.quietBase)}`);
  if (p.absorption) extras.push(`Absorption +${Math.round(p.absorption)}`);
  if (p.catalyst) extras.push(`Catalysts +${p.catalyst}`);
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
    else if (!CONFIG.paper.auto && !c.headerLines) L.push('📝 Tap "Paper buy" below to take this trade on paper.');
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

// ── /check <CA> report ──────────────────────────────────────
export function checkMessage(c) {
  const sym = c.pool.baseToken.symbol;
  const head = [`🔍 CHECK · $${sym} — ${c.score.total}/100`];
  if (c.failed.length) {
    head.push(`Would NOT alert — fails ${c.failed.length} of your rules:`);
    for (const f of c.failed) head.push(`❌ ${f}`);
  } else if (c.verdict === 'buy') {
    head.push('✅ Passes all your rules — this would be a 🟢 BUY ZONE alert.');
  } else if (c.verdict === 'watch') {
    head.push(c.score.buyBlocked ? `✅ Passes your rules, but ${c.score.buyBlockedWhy || 'trading looks bot-driven'} — 👀 watch only.` : `✅ Passes all your rules — 👀 WATCH level (${CONFIG.alertScore - c.score.total} pts short of buy zone).`);
  } else {
    head.push(`✅ Passes your rules, but scores below the watch level (${CONFIG.watchScore}).`);
  }
  head.push('No paper trade opened — this is a manual check.');
  const tier = c.verdict === 'buy' ? 'buy' : 'watch';
  return alertMessage({ ...c, tier, headerLines: head, paperOpened: null });
}

// ── coin already pumping: pullback odds + entry zone ────────
export function pumpMessage(c) {
  const { pool, plan, conc, community, flow, holdersCount, warnings, baseMcap } = c;
  const sym = pool.baseToken.symbol;
  const L = [];
  const statusTxt = {
    above: `Price is still ${Math.round((pool.priceUsd / plan.entryTop - 1) * 100)}% above the entry zone — wait for the pullback.`,
    'in-zone': '⚡ Price is IN the entry zone right now.',
    deep: '⚠️ Price is already below the deep end of the zone — the pump may be failing; only enter if it holds the stop level.',
  }[plan.status];

  L.push(`🚀 PUMPING · $${sym} — up ${Math.round(pool.change.h24)}% in 24h (peaked +${Math.round(plan.gain * 100)}%)`);
  L.push(plan.roundTrip
    ? `⚠️ Don't chase. On this chain, pumps this size usually give back ~${Math.round(plan.retraceMedian * 100)}% of the move — most round-trip to where they started. Treat it as a fresh setup later, near the pre-pump price.`
    : "Don't chase. Here's where it usually pulls back to, based on past pumps.");
  L.push(statusTxt);

  L.push('', '💰 SIZE');
  L.push(bullet(`Market cap before the pump ${usd(baseMcap)} → now ${usd(pool.marketCap)}`));
  L.push(bullet(`Liquidity ${usd(pool.liquidityUsd)} — ${liquidityNote(pool.liquidityUsd, pool.marketCap)}`));

  L.push('', `📉 PULLBACK ODDS (${plan.proven ? `${plan.n} past +${plan.key.replace('-', '–')}% pumps on Robinhood Chain` : 'not enough chain history yet — textbook 38–62% retrace'})`);
  if (plan.proven) {
    L.push(bullet(`${Math.round(plan.pPullback30 * 100)}% pulled back 30%+ within a week`));
    L.push(bullet(`Typically gave back ${Math.round(plan.retraceMedian * 100)}% of the move${plan.medianDaysToLow ? `, bottoming ~${plan.medianDaysToLow} day(s) after the peak` : ''}`));
    L.push(bullet(`${Math.round(plan.pNewHigh14 * 100)}% went on to a new high within 2 weeks · ${Math.round(plan.pFullRetrace * 100)}% gave back the whole move`));
  } else {
    L.push(bullet('Most pumps give back 38–62% of the move before deciding direction'));
    L.push(bullet('Chain-specific odds will appear after the daily research builds enough history'));
  }

  L.push('', '🎯 ENTRY PLAN');
  L.push(bullet(`Peak ${px(plan.peak)} · now ${px(plan.price)} (${Math.round(plan.offPeak * 100)}% off the peak)`));
  L.push(bullet(`Entry zone: ${px(plan.entryTop)} → ${px(plan.entryDeep)}`));
  L.push(bullet(`Best limit buy: ${px(plan.entryMid)} (the typical pullback)${plan.mcapEntry ? ` ≈ ${usd(plan.mcapEntry)} market cap` : ''}`));
  L.push(bullet(`Stop: ${px(plan.stop)} — below the deepest typical pullback (risk ${Math.round(plan.riskPct)}% from the limit)`));
  L.push(bullet(`From that entry: 3x = ${px(plan.target3x)}${plan.mcap3x ? ` (${usd(plan.mcap3x)} mc)` : ''} · 10x = ${px(plan.target10x)}${plan.mcap10x ? ` (${usd(plan.mcap10x)} mc)` : ''}`));

  L.push('', '👥 IS THE PUMP REAL?');
  L.push(bullet(`${num(holdersCount)} holders · ${pool.buyers24h} bought / ${pool.sellers24h} sold in 24h`));
  if (conc) L.push(bullet(`Top 10 wallets hold ${conc.top10Pct.toFixed(1)}%${conc.top1Pct != null ? ` · biggest ${conc.top1Pct.toFixed(1)}%` : ''}`));
  if (flow) {
    L.push(bullet(`${flow.uniqueBuyers} different wallets bought in the last ${flow.windowHours}h · ${flow.netFlowUsd >= 0 ? `${usd(flow.netFlowUsd)} more bought than sold` : `${usd(-flow.netFlowUsd)} more sold than bought`}`));
    if (flow.smartBuyers.length) L.push(bullet(`🧠 ${flow.smartBuyers.length} proven wallet(s) are in`));
  }
  if (community?.x) L.push(bullet(`X @${community.x} — check who's talking: https://x.com/search?q=%24${encodeURIComponent(sym)}%20filter%3Ablue_verified&f=live`));

  if (warnings?.length) {
    L.push('', '⚠️ HEADS UP');
    for (const wn of warnings) L.push(bullet(wn));
  }

  L.push('', '🔗 LINKS');
  L.push(`Chart: ${chartUrl(pool.poolAddress)}`);
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
export function digestMessage({ paper, eq, stats, regime, funnel, buy24h, watch24h, walletStats, sinceLast, scorecard, eth }) {
  const start = CONFIG.paper.startingBankroll;
  const change = ((eq - start) / start) * 100;
  const L = [];
  L.push(`📋 HOOD SCANNER — summary (every ${CONFIG.digestEveryHours}h)`);
  if (sinceLast) L.push(`Since the last summary (${sinceLast.hours}h ago): ${sinceLast.buy} buy-zone, ${sinceLast.watch} watch alert(s)`);

  if (!CONFIG.paper.auto) {
    L.push('', '💵 PAPER TRADING — send /paper for your positions, wallet and P/L');
  } else {
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
  }

  L.push('', '🔔 LAST 24 HOURS');
  L.push(bullet(`${buy24h} buy-zone alert(s) · ${watch24h} watch alert(s)`));
  L.push(bullet(`${funnel.runs} scans ran. A typical scan looked at ${funnel.scanned} coins → ${funnel.quickPass} survived the junk filter → ${funnel.deepPass} passed the full safety check`));
  const mood = { 'risk-on': 'heating up', 'risk-off': 'cooling off', neutral: 'normal' }[regime.state] || regime.state;
  if (eth?.price) {
    L.push(bullet(`ETH $${Math.round(eth.price).toLocaleString('en-US')}${eth.h24 != null ? ` · ${pctTxt(eth.h24, 1)} 24h` : ''}${eth.d7 != null ? ` · ${pctTxt(eth.d7, 1)} 7d` : ''} — ${{ strong: 'tailwind for ETH-paired coins', weak: 'headwind for ETH-paired coins', flat: 'no big ETH push either way', unknown: 'trend builds as history collects' }[eth.trend]}`));
  }
  L.push(bullet(`Chain-wide trading is ${mood}${regime.ratio ? ` (${regime.ratio.toFixed(2)}× the usual volume)` : ''}`));

  if (scorecard && Object.keys(scorecard).length) {
    L.push('', '🎯 ALERT SCORECARD (did alerts reach 3x before −50%? tracked 30 days)');
    const names = { buy: '🟢 Buy', watch: '👀 Watch', pump: '🚀 Pump', ignition: '🔥 Ignition' };
    for (const [k, g] of Object.entries(scorecard).sort()) {
      const [tier, lane] = k.split('/');
      const closed = g.win + g.stopped + g.expired;
      L.push(bullet(`${names[tier] || tier}${lane ? ` (${lane})` : ''}: ${g.n} alert(s) · ✅ ${g.win} hit 3x · ❌ ${g.stopped} fell 50% · ⏹ ${g.expired} expired · ${g.open} still open${closed ? ` · ${Math.round(g.winRate * 100)}% win rate` : ''} · ${g.hit2x} touched 2x`));
    }
  }

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

// ── 🔥 IGNITION: volume exploding out of a quiet base ───────
export function ignitionMessage({ token, base, sig, pool }) {
  const L = [];
  L.push(`🔥 IGNITION · $${base.symbol}`);
  L.push(`Hourly volume just jumped to ${sig.mult.toFixed(1)}× its quiet-base normal, and price is up ${pctTxt(sig.movePct)} in the last ${CONFIG.ignition.hours}h.`);
  L.push(`This is how the case-study second legs started — FRONG went 5.4× within a day of it. It's fast: decide within the hour.`);
  L.push('', '📍 WHERE IT IS');
  L.push(bullet(`${base.lane === 'quality' ? '🏛 Quality lane' : '🧪 Micro lane (small size only)'} · market cap ${usd(pool?.marketCap)} · liquidity ${usd(pool?.liquidityUsd)}`));
  if (base.drawdownPct != null) {
    L.push(bullet(base.type === 'absorption'
      ? `Was ${Math.round(base.drawdownPct)}% off its high, absorbing sellers (volume ${base.volTrend?.toFixed(2) ?? '—'}× with flat price) before this`
      : `Was ${Math.round(base.drawdownPct)}% off its high, volume dried to ${base.volTrend?.toFixed(2) ?? '—'}× before this`));
  }
  if (sig.aboveBasePct != null) L.push(bullet(sig.aboveBasePct <= 0 ? 'Price is still inside the base — early' : `Price is ${Math.round(sig.aboveBasePct)}% above the top of the base`));
  if (pool?.marketCap) L.push(bullet(`🎯 ${CONFIG.targetMinX}–${CONFIG.targetMaxX}x = ${usd(pool.marketCap * CONFIG.targetMinX)} to ${usd(pool.marketCap * CONFIG.targetMaxX)} market cap`));
  L.push('', '⚠️ BEFORE YOU BUY');
  L.push(bullet('Check X / Telegram for the reason (listing? big account? buyback?). No reason = more likely a bot pump.'));
  L.push(bullet(`Most pumps pull back — the plan still sells half at ${CONFIG.paper.takeProfits[0].x}x. Send /check ${token.slice(0, 8)}… for the full report.`));
  L.push('', `Chart: ${chartUrl(base.pool)}`);
  L.push(`CA: ${token}`);
  return L.filter((l) => l !== null).join('\n');
}
