import * as BG from './budget.js';
// HOOD SCANNER — Telegram command relay (Cloudflare Worker, free plan)
//
// Telegram → this Worker → GitHub Actions. Commands:
//   /scan               run a full scan now
//   /check <address>    full report on one coin (or just paste an address)
//   /research           run the research job now
//   /status             last scan (instant)
//   /paper              paper-trading menu: place trade · TP/SL · positions · wallet · P/L
//   /help               list commands
//
// Paper trading lives here (not in GitHub): a KV namespace bound as PAPER stores the
// paper wallet, and the 15-minute cron marks positions to market and fills TP/SL/limits.
//
// Settings → Variables and Secrets (all as "Secret" except GITHUB_REPO):
//   TELEGRAM_BOT_TOKEN  your bot token from BotFather
//   ALLOWED_CHAT_ID     your Telegram chat id — only this chat can use the bot
//   GITHUB_TOKEN        fine-grained token: hood-scanner repo, Actions = Read and write
//   WEBHOOK_SECRET      any random 20+ letters/numbers you make up
//   GITHUB_REPO         itsloashh/hood-scanner   (plain text variable)
// Bindings → KV namespace:  PAPER  (any namespace you create, e.g. "hood-paper")
//
// After deploying, open:  https://<your-worker>.workers.dev/setup?key=<WEBHOOK_SECRET>
//
// It is also the bot's CLOCK. Add two Cron Triggers (Settings → Triggers):
//   */15 * * * *    → full scan every 15 minutes
//   23 14 * * *     → research every day (~10:23 AM Toronto)
// GitHub's own schedule stays on as a backup; the scanner skips duplicates.

const ADDR = /^0x[0-9a-fA-F]{40}$/;

const HELP = [
  '🤖 HOOD SCANNER commands',
  '',
  '/scan — run a full scan now (results in ~4 min)',
  '/check 0x… — full report on one coin, even if it fails your rules',
  '   (or just paste a contract address)',
  '/research — run the research job now (10–30 min)',
  '/catalyst 0x… what happened — tag a coin with news (Robinhood listing, big follow…) for +6 score for 2 weeks',
  '   /catalyst 0x… remove — untag · /catalyst — list tags',
  '/paper — paper trading: place trade · TP/SL · positions · wallet · P/L',
  '/signals — every coin the bot has called: when, at what price, and how it\'s doing',
  '/status — what the last scan found, instantly',
  '',
  '🌍 FX desk (XAU/USD · CAD/JPY):',
  '/fx — FX menu: each pair, calendar, headlines, drivers, track record',
  '/fxcal — this week\'s USD · CAD · JPY releases',
  '/fxbrief — full brief now (also automatic 6:45 AM weekdays + Sunday 6 PM)',
  '',
  '💰 Budget assistant:',
  '/budget — bills, set-asides and buckets (buttons)',
  '/paid 1850 — log a paycheque and sort it',
  '/bill Rent 1200 on the 1st — add a monthly bill',
  '/spent 40 drinks — log spending (bucket picked from the words, or tap one)',
  '/help — this list',
  '',
  'Alerts only arrive when a coin qualifies — a quiet scan sends nothing.',
].join('\n');

// Permanent button bar at the bottom of the chat (sent with /start, /help or /menu)
const MENU_BUTTONS = { '💰 Budget': '/budget', '🌍 FX desk': '/fx', '📅 FX calendar': '/fxcal', '📜 Signals': '/signals', '📋 Paper': '/paper', '📍 Status': '/status', '🚀 Scan now': '/scan' };
const MENU_KEYBOARD = {
  keyboard: [[{ text: '💰 Budget' }, { text: '🌍 FX desk' }, { text: '📅 FX calendar' }], [{ text: '📜 Signals' }, { text: '📋 Paper' }], [{ text: '📍 Status' }, { text: '🚀 Scan now' }]],
  resize_keyboard: true,
  is_persistent: true,
};

const COMMANDS = [
  { command: 'scan', description: 'Run a full scan now' },
  { command: 'check', description: 'Check one coin: /check 0x…' },
  { command: 'research', description: 'Run the research job now' },
  { command: 'catalyst', description: 'Tag a coin with news: /catalyst 0x… listing' },
  { command: 'paper', description: 'Paper trading menu' },
  { command: 'signals', description: 'Every coin called + how it did' },
  { command: 'status', description: 'What the last scan found' },
  { command: 'budget', description: 'Budget: bills, paycheques, buckets' },
  { command: 'paid', description: 'Log a paycheque: /paid 1850' },
  { command: 'spent', description: 'Log spending: /spent 40 drinks' },
  { command: 'fx', description: 'Gold + CAD/JPY lean and levels' },
  { command: 'fxcal', description: 'This week\'s USD/CAD/JPY releases' },
  { command: 'fxbrief', description: 'Full FX brief now' },
  { command: 'menu', description: 'Show the button bar' },
  { command: 'help', description: 'List commands' },
];

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ ok: false }));
}

const reply = (env, chatId, text) => tg(env, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });

async function dispatch(env, workflow, inputs = {}) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'hood-scanner-telegram',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (res.status === 204) return { ok: true };
  const detail = (await res.text().catch(() => '')).slice(0, 160);
  return { ok: false, status: res.status, detail };
}

function dispatchError(r) {
  if (r.status === 401) return 'GitHub rejected the token (expired or wrong). Make a new one and update GITHUB_TOKEN.';
  if (r.status === 403 || r.status === 404) return 'GitHub token lacks access — it needs the hood-scanner repo with Actions: Read and write.';
  return `GitHub said ${r.status}: ${r.detail}`;
}

const usd = (v) => (v == null ? '—' : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Number(v).toFixed(2)}`);

async function status(env) {
  const url = `https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/data/state.json?t=${Date.now()}`;
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) return `Couldn't read the bot's data (${res.status}).`;
  const s = await res.json();
  const r = s.lastRun || {};
  const mins = r.at ? Math.round((Date.now() - Date.parse(r.at)) / 60000) : null;
  const L = ['📍 STATUS'];
  L.push(`Last scan: ${mins == null ? 'unknown' : mins < 1 ? 'just now' : `${mins} min ago`}`);
  if (r.scanned != null) L.push(`${r.scanned} coins → ${r.quickPass} survived the junk filter → ${r.deepPass} passed the full check`);
  if (r.buy != null) L.push(`That scan sent: ${r.buy} buy-zone, ${r.watch} watch alert(s)`);
  if (r.regime) L.push(`Market: ${{ 'risk-on': 'heating up', 'risk-off': 'cooling off', neutral: 'normal' }[r.regime] || r.regime}`);
  const paper = await loadPaper(env).catch(() => null);
  if (paper) L.push('', `💵 Paper: ${usd(paper.cash)} cash · ${paper.positions.length} open · ${paper.orders.length} limit order(s) — /paper for details`);
  if (r.scorecard && Object.keys(r.scorecard).length) {
    L.push('', '🎯 Alert scorecard (3x before −50%, 30 days):');
    for (const [k, g] of Object.entries(r.scorecard)) L.push(`• ${k}: ${g.n} alerts · ✅${g.win} ❌${g.stopped} ⏹${g.expired} · ${g.open} open`);
  }
  if (r.wallets) L.push('', `🧠 Tracking ${r.wallets.tracked} wallets · ${r.wallets.smart} smart`);
  if (r.httpErrors && Object.keys(r.httpErrors).length) {
    const name = (h) => h.split('.').slice(-2, -1)[0] || h; // api.blockscout.com → blockscout
    L.push('', `⚠️ Data source hiccups last scan (the scan carried on): ${Object.entries(r.httpErrors).map(([h, e]) => `${name(h)} — ${e.last}`).join('; ')}`);
  }
  return L.join('\n');
}

// ── FX desk clock (Toronto time) ─────────────────────────────
// 9:00 AM Toronto: bill reminders
export function budgetClock(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Number(p.hour) % 24 === 9 && Number(p.minute) < 5;
}

export async function budgetTick(env) {
  const b = await BG.loadBudget(env);
  if (!b || (!b.bills.length && !b.history.length)) return [];
  const msgs = BG.dailyReminders(b);
  await BG.saveBudget(env, b);
  if (msgs.length) await tg(env, 'sendMessage', { chat_id: env.ALLOWED_CHAT_ID, text: `💰 BILLS\n\n${msgs.join('\n\n')}`, reply_markup: { inline_keyboard: [[{ text: '💰 Budget home', callback_data: 'bg' }]] } });
  return msgs;
}

export function fxClock(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  const m = Number(p.minute);
  const wk = p.weekday;
  if (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wk) && h === 6 && m >= 45 && m < 50) return 'brief';
  if (wk === 'Sun' && h === 18 && m < 5) return 'weekly';
  if (wk === 'Sat' || (wk === 'Sun' && h < 17) || (wk === 'Fri' && h >= 17)) return null; // market closed
  return m % 15 >= 5 && m % 15 < 10 ? 'watch' : null;
}

async function fxLatest(env) {
  const res = await fetch(`https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/data/fx/latest.json?t=${Math.floor(Date.now() / 60000)}`, { headers: { 'cache-control': 'no-cache' } });
  return res.ok ? res.json() : null;
}

const fxNum = (v, d) => (v == null ? '—' : Number(v).toFixed(d));
const fxPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`);
const fxWhen = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Toronto', weekday: 'short', hour: 'numeric', minute: '2-digit' });

export async function fxStatus(env) {
  const x = await fxLatest(env);
  if (!x) return '🌍 FX desk has no data yet — send /fxbrief to run it now.';
  const mins = Math.round((Date.now() - Date.parse(x.at)) / 60000);
  const L = [`🌍 FX DESK — updated ${mins < 1 ? 'just now' : `${mins} min ago`}`, ''];
  for (const p of Object.values(x.pairs)) {
    const icon = p.lean.startsWith('Bullish') ? '🟢' : p.lean.startsWith('Bearish') ? '🔴' : '⚪';
    L.push(`${icon} ${p.name} ${fxNum(p.price, p.decimals)} (${fxPct(p.dayChange)} today)`);
    L.push(`Lean: ${p.lean} (${p.score > 0 ? '+' : ''}${p.score} of ±${p.max})`);
    for (const r of p.reasons.slice(0, 5)) L.push(`  ${r}`);
    if (p.levels) L.push(`Prev day ${fxNum(p.levels.prevDayLow, p.decimals)}–${fxNum(p.levels.prevDayHigh, p.decimals)} · ATR ${fxNum(p.levels.atr, p.decimals)}`);
    L.push('');
  }
  const next = (x.events || []).filter((e) => e.impact === 'High' && e.at > Date.now()).slice(0, 3);
  if (next.length) L.push('Next high-impact:', ...next.map((e) => `🔴 ${fxWhen(e.at)} ${e.country} ${e.title}`), '');
  L.push('Context only — not trade signals. /fxcal for the week · /fxbrief for the full brief');
  return L.join('\n');
}

export async function fxCalendar(env) {
  const x = await fxLatest(env);
  if (!x) return '📅 No calendar yet — send /fxbrief to run the FX desk now.';
  const up = (x.events || []).filter((e) => e.at > Date.now() - 3_600_000);
  if (!up.length) return '📅 No more high/medium-impact USD · CAD · JPY releases this week.';
  const L = ['📅 THIS WEEK — USD · CAD · JPY (Toronto time)'];
  for (const e of up.slice(0, 30)) L.push(`${e.impact === 'High' ? '🔴' : '🟠'} ${fxWhen(e.at)} ${e.country} ${e.title}${e.forecast ? ` (fcst ${e.forecast}${e.previous ? `, prev ${e.previous}` : ''})` : ''}`);
  return L.join('\n');
}

// ── FX desk screens (buttons). Every screen starts with "FX ·" so taps edit it in place.
const FX_PAIRS = { XAUUSD: '🥇 Gold', CADJPY: '🇨🇦🇯🇵 CAD/JPY' };
const leanDot = (l) => (l.startsWith('Bullish') ? '🟢' : l.startsWith('Bearish') ? '🔴' : '⚪');
const fxNav = [{ text: '🌍 FX menu', callback_data: 'fx' }];
const fxStale = (x) => {
  const mins = Math.round((Date.now() - Date.parse(x.at)) / 60000);
  return mins < 1 ? 'just now' : mins < 120 ? `${mins} min ago` : `${Math.round(mins / 60)}h ago`;
};
const noFx = { text: 'FX · no data yet\n\nThe FX desk hasn\'t run yet. Tap "Full brief now" to run it.', kb: [[{ text: '🌍 Full brief now', callback_data: 'fxb' }]] };

export async function fxMenu(env) {
  const x = await fxLatest(env);
  if (!x) return noFx;
  const L = [`FX · 🌍 FX DESK — updated ${fxStale(x)}`, ''];
  for (const [k, p] of Object.entries(x.pairs)) {
    L.push(`${leanDot(p.lean)} ${p.name} ${fxNum(p.price, p.decimals)} (${fxPct(p.dayChange)} today)`);
    L.push(`   ${p.lean} (${p.score > 0 ? '+' : ''}${p.score} of ±${p.max})`);
  }
  const next = (x.events || []).find((e) => e.impact === 'High' && e.at > Date.now());
  if (next) L.push('', `Next high-impact: ${fxWhen(next.at)} ${next.country} ${next.title}`);
  if (x.priceNotes?.length) L.push('', ...x.priceNotes.map((n) => `⚠️ ${n}`));
  L.push('', 'Context only — not trade signals.');
  const kb = [
    Object.entries(FX_PAIRS).filter(([k]) => x.pairs[k]).map(([k, label]) => ({ text: label, callback_data: `fxp:${k}` })),
    [{ text: '📅 Calendar', callback_data: 'fxc:today' }, { text: '📰 Headlines', callback_data: 'fxn:all' }],
    [{ text: '📊 Drivers & rates', callback_data: 'fxd' }, { text: '🎯 Track record', callback_data: 'fxr' }],
    [{ text: '🌍 Full brief now', callback_data: 'fxb' }, { text: '🔄 Refresh', callback_data: 'fx' }],
  ];
  return { text: L.join('\n'), kb };
}

export async function fxPairScreen(env, key) {
  const x = await fxLatest(env);
  const p = x?.pairs?.[key];
  if (!p) return noFx;
  const d = p.decimals;
  const lv = p.levels || {};
  const L = [`FX · ${leanDot(p.lean)} ${p.name} — ${fxNum(p.price, d)} (${fxPct(p.dayChange)} today)`, `Updated ${fxStale(x)}${p.source ? ` · price: ${p.source}` : ''}`, ''];
  L.push(`LEAN: ${p.lean} (${p.score > 0 ? '+' : ''}${p.score} of ±${p.max})`);
  for (const r of p.reasons) L.push(`  ${r}`);
  L.push('', 'STRUCTURE');
  if (p.daily) L.push(`• Daily: ${p.daily}`);
  if (p.hourly) L.push(`• Hourly: ${p.hourly}`);
  L.push('', 'LEVELS');
  L.push(`• Previous day: ${fxNum(lv.prevDayLow, d)} – ${fxNum(lv.prevDayHigh, d)}`);
  if (lv.prevWeekHigh) L.push(`• Previous week: ${fxNum(lv.prevWeekLow, d)} – ${fxNum(lv.prevWeekHigh, d)}`);
  if (lv.sma50) L.push(`• 50-day avg ${fxNum(lv.sma50, d)}${lv.sma200 ? ` · 200-day avg ${fxNum(lv.sma200, d)}` : ''}`);
  if (lv.atr) L.push(`• Typical daily range (ATR): ${fxNum(lv.atr, d)}`);
  const cur = key === 'XAUUSD' ? ['USD'] : ['CAD', 'JPY'];
  const next = (x.events || []).filter((e) => cur.includes(e.country) && e.at > Date.now()).slice(0, 4);
  if (next.length) L.push('', 'NEXT RELEASES', ...next.map((e) => `${e.impact === 'High' ? '🔴' : '🟠'} ${fxWhen(e.at)} ${e.country} ${e.title}`));
  const other = Object.keys(FX_PAIRS).find((k) => k !== key);
  return {
    text: L.join('\n'),
    kb: [
      [{ text: '📰 Its headlines', callback_data: `fxn:${key}` }, { text: FX_PAIRS[other], callback_data: `fxp:${other}` }],
      [{ text: '🔄 Refresh', callback_data: `fxp:${key}` }, ...fxNav],
    ],
  };
}

export async function fxCalendarScreen(env, span = 'today') {
  const x = await fxLatest(env);
  if (!x) return noFx;
  const now = Date.now();
  const horizon = span === 'week' ? 8 * 86_400_000 : 24 * 3_600_000;
  const list = (x.events || []).filter((e) => e.at > now - 3_600_000 && e.at < now + horizon && (span === 'high' ? e.impact === 'High' : true));
  const title = { today: 'NEXT 24 HOURS', week: 'THIS WEEK', high: 'HIGH-IMPACT ONLY (this week)' }[span] || 'NEXT 24 HOURS';
  const L = [`FX · 📅 ${title} — USD · CAD · JPY (Toronto time)`, ''];
  const shown = span === 'high' ? (x.events || []).filter((e) => e.at > now - 3_600_000 && e.impact === 'High') : list;
  if (!shown.length) L.push('Nothing high or medium impact in this window.');
  for (const e of shown.slice(0, 30)) L.push(`${e.impact === 'High' ? '🔴' : '🟠'} ${fxWhen(e.at)} ${e.country} ${e.title}${e.forecast ? ` (fcst ${e.forecast}${e.previous ? `, prev ${e.previous}` : ''})` : ''}`);
  L.push('', '🔴 high impact · 🟠 medium. You get a heads-up 30 min before every 🔴 release and the result after.');
  return {
    text: L.join('\n'),
    kb: [
      [['today', 'Next 24h'], ['week', 'This week'], ['high', '🔴 only']].filter(([k]) => k !== span).map(([k, t]) => ({ text: t, callback_data: `fxc:${k}` })),
      fxNav,
    ],
  };
}

export async function fxHeadlinesScreen(env, which = 'all') {
  const x = await fxLatest(env);
  if (!x) return noFx;
  const name = { XAUUSD: 'Gold (XAU/USD)', CADJPY: 'CAD/JPY' }[which];
  const list = (x.headlines || []).filter((h) => !name || (h.pairs || []).includes(name));
  const L = [`FX · 📰 HEADLINES${name ? ` — ${name}` : ''} (trusted outlets)`, ''];
  if (!list.length) L.push('No matching headlines in the last run.');
  for (const h of list.slice(0, 10)) L.push(`• ${h.title}`, `   ${h.source || ''}${h.at ? ` · ${fxWhen(h.at)}` : ''}`);
  return {
    text: L.join('\n'),
    kb: [
      [['all', 'All'], ['XAUUSD', '🥇 Gold'], ['CADJPY', '🇨🇦🇯🇵 CAD/JPY']].filter(([k]) => k !== which).map(([k, t]) => ({ text: t, callback_data: `fxn:${k}` })),
      fxNav,
    ],
  };
}

export async function fxDriversScreen(env) {
  const x = await fxLatest(env);
  if (!x) return noFx;
  const L = ['FX · 📊 DRIVERS & RATES', ''];
  for (const m of Object.values(x.drivers || {})) L.push(`${m.d1 >= 0 ? '▲' : '▼'} ${m.name}: ${fxPct(m.d1)} today · ${fxPct(m.d5)} this week`);
  const mac = Object.values(x.macro || {});
  if (mac.length) {
    L.push('');
    const bp = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)} bp`;
    for (const m of mac) L.push(`${m.d1bp >= 0 ? '▲' : '▼'} ${m.name}: ${m.v.toFixed(2)}% (${bp(m.d1bp)} · week ${bp(m.d5bp)})`);
  }
  L.push('', 'Gold usually moves against the dollar, real yields and the 2-yr yield, and with fear (VIX).', 'CAD/JPY usually moves with oil, stocks and the Nikkei, and against fear.');
  return { text: L.join('\n'), kb: [fxNav] };
}

export async function fxRecordScreen(env) {
  const x = await fxLatest(env);
  if (!x) return noFx;
  const L = ['FX · 🎯 LEAN TRACK RECORD', 'Every morning brief logs each pair\'s lean, then checks where price went.', ''];
  const rec = Object.entries(x.record || {}).filter(([, r]) => r.dayN || r.weekN);
  if (!rec.length) L.push('Not enough history yet — the first results appear the day after the first briefs.');
  for (const [k, r] of rec) {
    const pctR = (a, n) => (n ? ` (${Math.round((a / n) * 100)}%)` : '');
    L.push(`${FX_PAIRS[k] || k}`, `  Next day: ${r.dayRight}/${r.dayN} right${pctR(r.dayRight, r.dayN)}`, `  One week: ${r.weekRight}/${r.weekN} right${pctR(r.weekRight, r.weekN)}`, '');
  }
  L.push('Only bullish/bearish leans count — "mixed" isn\'t a call.');
  return { text: L.join('\n'), kb: [fxNav] };
}

async function catalystList(env) {
  const res = await fetch(`https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/data/catalysts.json?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  if (res.status === 404) return '⚡ No catalyst tags yet.\nTag one: /catalyst 0x… Robinhood app listing';
  if (!res.ok) return `Couldn't read catalysts (${res.status}).`;
  const coins = Object.entries((await res.json()).coins || {});
  if (!coins.length) return '⚡ No catalyst tags yet.';
  const L = ['⚡ CATALYST TAGS (count for 14 days)'];
  for (const [a, v] of coins) {
    const days = Math.floor((Date.now() - Date.parse(v.at)) / 86_400_000);
    L.push(`• ${a.slice(0, 6)}…${a.slice(-4)} — ${v.note} (${days}d ago${days >= 14 ? ', expired' : ''})`);
  }
  return L.join('\n');
}

async function handleMessage(env, msg) {
  const chatId = msg.chat?.id;
  if (String(chatId) !== String(env.ALLOWED_CHAT_ID)) return; // ignore everyone else, silently
  let text = (msg.text || '').trim();
  // bottom-of-chat button bar → commands
  if (MENU_BUTTONS[text]) text = MENU_BUTTONS[text];

  // budget assistant waiting for a typed answer (paycheque amount, a bill, an essential)
  if (env.PAPER && text && !text.startsWith('/')) {
    const b = await BG.loadBudget(env);
    if (b?.awaiting) {
      const scr = BG.handleText(b, text);
      if (scr) {
        await BG.saveBudget(env, b);
        return sendScreen(env, chatId, scr);
      }
    }
  }
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, ''); // /scan@MyBot → /scan

  // pasted contract address = /check
  if (ADDR.test(rawCmd)) return handleMessage(env, { ...msg, text: `/check ${rawCmd}` });

  if (cmd === '/start' || cmd === '/help' || cmd === '/menu') {
    return tg(env, 'sendMessage', { chat_id: chatId, text: HELP, disable_web_page_preview: true, reply_markup: MENU_KEYBOARD });
  }

  if (cmd === '/scan') {
    const r = await dispatch(env, 'scan.yml');
    return reply(env, chatId, r.ok
      ? '🚀 Scan started. Results in about 4 minutes.\nYou only get an alert if a coin qualifies — send /status afterwards to see what it found.'
      : `❌ Couldn't start the scan. ${dispatchError(r)}`);
  }

  if (cmd === '/check') {
    const ca = args[0] || '';
    if (!ADDR.test(ca)) return reply(env, chatId, 'Send it like this:\n/check 0x1234…abcd\n(or just paste the contract address)');
    const r = await dispatch(env, 'scan.yml', { ca: ca.toLowerCase() });
    return reply(env, chatId, r.ok
      ? `🔍 Checking ${ca.slice(0, 6)}…${ca.slice(-4)} — full report in about 1–2 minutes.`
      : `❌ Couldn't start the check. ${dispatchError(r)}`);
  }

  if (cmd === '/research') {
    const r = await dispatch(env, 'research.yml');
    return reply(env, chatId, r.ok
      ? '🔬 Research started. It takes 10–30 minutes; the summary will arrive here.'
      : `❌ Couldn't start research. ${dispatchError(r)}`);
  }

  if (cmd === '/catalyst') {
    const ca = args[0] || '';
    if (!ca) return reply(env, chatId, await catalystList(env).catch((e) => `Couldn't read catalysts: ${e.message}`));
    if (!ADDR.test(ca)) return reply(env, chatId, 'Send it like this:\n/catalyst 0x1234…abcd Robinhood app listing\n/catalyst 0x1234…abcd remove');
    const note = args.slice(1).join(' ').slice(0, 120);
    const r = await dispatch(env, 'catalyst.yml', { ca: ca.toLowerCase(), note });
    return reply(env, chatId, r.ok ? '⚡ Saving that catalyst — confirmation in about a minute.' : `❌ Couldn't save it. ${dispatchError(r)}`);
  }

  if (cmd === '/signals') return sendScreen(env, chatId, await signalsScreen(env).catch((e) => ({ text: `Couldn't load signals: ${e.message}`, kb: [] })));

  if (cmd === '/spent' || cmd === '/spend') {
    if (!env.PAPER) return reply(env, chatId, needKV.text);
    const b = await BG.loadBudget(env);
    const sp = args.length ? BG.parseSpend(args.join(' '), null, b) : null;
    let scr;
    if (sp) {
      scr = BG.spentScreen(b, BG.logSpend(b, sp));
      b.awaiting = null;
    } else {
      b.awaiting = 'spend';
      scr = BG.spendPickScreen(b);
    }
    await BG.saveBudget(env, b);
    return sendScreen(env, chatId, scr);
  }

  if (cmd === '/budget' || cmd === '/paid' || cmd === '/bill') {
    if (!env.PAPER) return reply(env, chatId, needKV.text);
    const b = await BG.loadBudget(env);
    let scr;
    if (cmd === '/budget') scr = BG.handleTap(b, 'bg');
    else {
      b.awaiting = cmd === '/paid' ? 'pay' : 'bill';
      scr = args.length ? BG.handleText(b, args.join(' ')) : { text: cmd === '/paid' ? BG.ASK.pay : BG.ASK.bill, kb: [[{ text: '💰 Budget home', callback_data: 'bg' }]] };
      if (cmd === '/bill' && args.length) b.awaiting = null;
    }
    await BG.saveBudget(env, b);
    return sendScreen(env, chatId, scr);
  }

  if (cmd === '/fx') return sendScreen(env, chatId, await fxMenu(env).catch((e) => ({ text: `Couldn't read FX data: ${e.message}`, kb: [] })));
  if (cmd === '/fxcal') return sendScreen(env, chatId, await fxCalendarScreen(env, 'week').catch((e) => ({ text: `Couldn't read FX data: ${e.message}`, kb: [] })));
  if (cmd === '/fxbrief') {
    const r = await dispatch(env, 'fx.yml', { mode: 'brief' });
    return reply(env, chatId, r.ok ? '🌍 FX brief started — arrives in about 1–2 minutes.' : `❌ Couldn't start the FX brief. ${dispatchError(r)}`);
  }

  if (cmd === '/paper') return sendScreen(env, chatId, await mainScreen(env));

  if (cmd === '/status') return reply(env, chatId, await status(env).catch((e) => `Couldn't read status: ${e.message}`));

  return reply(env, chatId, `Didn't catch that.\n\n${HELP}`);
}


// ════════════════════════════════════════════════════════════
//  PAPER TRADING (Telegram buttons + KV)
// ════════════════════════════════════════════════════════════
const GT = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
const DEFAULTS = { start: 30, moveStep: 10, sizePct: 10, sl: -50, tp1: 3, tp1Sell: 50, tp2: 5, tp2Sell: 25, runner: 10, trail: 40, slip: 3, orderHours: 48 };
const money = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const n = a >= 1e6 ? `${(a / 1e6).toFixed(2).replace(/\.?0+$/, '')}M` : a >= 1000 ? `${(a / 1000).toFixed(1)}k` : a.toFixed(2);
  return `${v < 0 ? '−' : ''}$${n}`;
};
const START_AMOUNTS = [30, 100, 1000, 10000];
// trade size as a % of cash (rounded down to the cent)
const sizeFor = (cash, pct) => Math.floor(cash * pct) / 100;
const signed = (v) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v)).replace('−', '')}`;
const price = (v) => (v == null ? '—' : v >= 1 ? `$${v.toFixed(4)}` : `$${Number(v).toPrecision(3)}`);
const pctS = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;

export function freshPaper(now = Date.now(), start = DEFAULTS.start) {
  return { cash: start, start, settings: { ...DEFAULTS }, positions: [], orders: [], closed: [], nextId: 1, createdAt: now };
}

export async function loadPaper(env) {
  if (!env.PAPER) return null;
  const p = await env.PAPER.get('paper', 'json');
  if (!p) return freshPaper();
  p.settings = { ...DEFAULTS, ...(p.settings || {}) };
  return p;
}
const savePaper = (env, p) => env.PAPER.put('paper', JSON.stringify(p));

// Live prices. Tries, in order:
//   1. GeckoTerminal pools (price + liquidity + market cap)
//   2. GeckoTerminal token price (if the pool lookup missed)
//   3. the scanner's own price from its last run (≤45 min old), marked as such
// items: [{ pool, token }] → { [pool]: { price, liq, mcap, source } }
const GT_HEADERS = { accept: 'application/json', 'user-agent': 'hood-scanner-bot/1.0 (+https://github.com/itsloashh/hood-scanner)' };
export const priceErrors = [];

async function gtJson(url) {
  try {
    const res = await fetch(url, { headers: GT_HEADERS });
    if (!res.ok) {
      priceErrors.push(`GeckoTerminal HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    priceErrors.push(`GeckoTerminal unreachable (${String(e.message).slice(0, 40)})`);
    return null;
  }
}

// ── DexPaprika backup (api.dexpaprika.com, keyless, ~15 calls/min) ──
const DP = 'https://api.dexpaprika.com/networks/robinhood';
async function dpGet(path) {
  try {
    const res = await fetch(`${DP}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      priceErrors.push(`DexPaprika ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    priceErrors.push(`DexPaprika ${e.message}`.slice(0, 80));
    return null;
  }
}
export async function dpToken(token) {
  const j = await dpGet(`/tokens/${token.toLowerCase()}`);
  if (!j) return null;
  return { symbol: j.symbol, price: Number(j.summary?.price_usd) || null, liq: Number(j.summary?.liquidity_usd) || null, fdv: Number(j.summary?.fdv) || null };
}
async function dpTopPool(token) {
  const j = await dpGet(`/pools/search?token_address=${token.toLowerCase()}&limit=1&order_by=volume_usd`);
  const p = (j?.pools || j?.results || [])[0];
  const id = (p?.id || p?.address || '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(id) ? id : null;
}

export async function priceMap(env, items) {
  const out = {};
  const list = items.filter((x) => x?.pool);
  const pools = [...new Set(list.map((x) => x.pool.toLowerCase()))];
  for (let i = 0; i < pools.length; i += 30) {
    const j = await gtJson(`${GT}/pools/multi/${pools.slice(i, i + 30).join(',')}`);
    for (const d of j?.data || []) {
      const a = d.attributes || {};
      const price = Number(a.base_token_price_usd);
      if (price > 0) out[(a.address || '').toLowerCase()] = { price, liq: Number(a.reserve_in_usd), mcap: Number(a.market_cap_usd || a.fdv_usd) || null, source: 'live' };
    }
  }
  const missing = list.filter((x) => !out[x.pool.toLowerCase()] && x.token);
  if (missing.length) {
    const j = await gtJson(`${GT.replace('/networks/robinhood', '/simple/networks/robinhood')}/token_price/${[...new Set(missing.map((x) => x.token.toLowerCase()))].slice(0, 30).join(',')}`);
    const tp = j?.data?.attributes?.token_prices || {};
    for (const x of missing) {
      const price = Number(tp[x.token.toLowerCase()] ?? tp[x.token]);
      if (price > 0) out[x.pool.toLowerCase()] = { price, liq: null, mcap: null, source: 'live' };
    }
  }
  // Backup source: DexPaprika (free, keyless, covers Robinhood Chain, separate rate limit from GeckoTerminal)
  for (const x of list.filter((y) => !out[y.pool.toLowerCase()] && y.token).slice(0, 10)) {
    const d = await dpToken(x.token);
    if (d?.price > 0) out[x.pool.toLowerCase()] = { price: d.price, liq: d.liq, mcap: d.fdv, source: 'live' };
  }
  let still = list.filter((x) => !out[x.pool.toLowerCase()]);
  // Every scan publishes all ~400 coin prices (data/prices.json) — reliable even when this
  // Worker's own lookups are rate-limited
  if (still.length && env) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/data/prices.json?t=${Math.floor(Date.now() / 60000)}`);
      const j = res.ok ? await res.json() : null;
      const ageMin = j?.at ? (Date.now() - Date.parse(j.at)) / 60000 : Infinity;
      if (ageMin < 40) {
        for (const x of still) {
          const row = j.p[(x.token || '').toLowerCase()] || Object.values(j.p).find((r) => r[3] === x.pool.toLowerCase());
          if (row?.[0] > 0) out[x.pool.toLowerCase()] = { price: row[0], liq: row[2] || null, mcap: row[1] || null, source: 'scan', ageMin: Math.round(ageMin) };
        }
      } else if (j) priceErrors.push(`last scan prices ${Math.round(ageMin)} min old`);
    } catch (e) {
      priceErrors.push(`scan prices unreadable (${String(e.message).slice(0, 40)})`);
    }
    still = list.filter((x) => !out[x.pool.toLowerCase()]);
  }
  if (still.length && env) {
    const cands = await candidates(env);
    for (const x of still) {
      const c = cands.find((k) => k.pool === x.pool.toLowerCase() || k.token === x.token);
      if (c?.price > 0 && Date.now() - Date.parse(c.at) < 45 * 60_000) {
        out[x.pool.toLowerCase()] = { price: c.price, liq: c.liquidity ?? null, mcap: c.mcap ?? null, source: 'scan' };
      }
    }
  }
  return out;
}

// kept for older callers: pools only, no fallbacks
export const poolPrices = (pools) => priceMap(null, pools.map((pool) => ({ pool })));

const noPriceMsg = () => `No live price right now${priceErrors.length ? ` (${[...new Set(priceErrors.slice(-3))].join('; ')})` : ''} — try again in a minute.`;

// any coin → its main pool + symbol
async function coinInfo(env, token) {
  const cands = await candidates(env);
  const c = cands.find((x) => x.token === token);
  if (c) return c;
  const j = await gtJson(`${GT}/tokens/multi/${token}?include=top_pools`);
  const d = j?.data?.[0];
  const poolId = d?.relationships?.top_pools?.data?.[0]?.id;
  if (poolId) return { token, symbol: d.attributes?.symbol || '???', pool: poolId.split('_').slice(1).join('_').toLowerCase(), tier: 'manual' };
  // GeckoTerminal unreachable from Cloudflare → DexPaprika
  const dp = await dpToken(token);
  if (!dp) return null;
  const pool = (await dpTopPool(token)) || token; // pool unknown → prices come from the token itself
  return { token, symbol: dp.symbol || '???', pool, tier: 'manual' };
}

export async function candidates(env) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/data/candidates.json?t=${Math.floor(Date.now() / 60000)}`);
    if (!res.ok) return [];
    return (await res.json()).coins || [];
  } catch {
    return [];
  }
}

const posValue = (pos) => pos.size * pos.rem * ((pos.last ?? pos.entry) / pos.entry);
const reserved = (p) => p.orders.reduce((s, o) => s + o.size, 0);
function equity(p) {
  return p.cash + reserved(p) + p.positions.reduce((s, x) => s + posValue(x), 0);
}

// ── trading actions ─────────────────────────────────────────
export function openPosition(p, { token, symbol, pool, px, size }, now = Date.now()) {
  const st = p.settings;
  if (!(px > 0)) return { error: 'No live price for this coin right now.' };
  if (size > p.cash + 1e-9) return { error: `Not enough cash — you have ${money(p.cash)}.` };
  if (size < 1) return { error: 'Minimum trade is $1.' };
  const entry = px * (1 + st.slip / 100);
  const pos = {
    id: p.nextId++, token, symbol, pool, entry, size, rem: 1, last: px, peak: px, realized: 0, openedAt: now,
    sl: st.sl, runner: st.runner, trail: st.trail,
    tps: [{ x: st.tp1, sell: st.tp1Sell, hit: false }, { x: st.tp2, sell: st.tp2Sell, hit: false }],
  };
  p.cash -= size;
  p.positions.push(pos);
  return { pos };
}

export function placeOrder(p, { token, symbol, pool, limit, size }, now = Date.now()) {
  if (!(limit > 0)) return { error: 'No entry price available for a limit order.' };
  if (size > p.cash + 1e-9) return { error: `Not enough cash — you have ${money(p.cash)}.` };
  const o = { id: p.nextId++, token, symbol, pool, limit, size, createdAt: now, expiresAt: now + p.settings.orderHours * 3_600_000 };
  p.cash -= size; // reserved until filled or cancelled
  p.orders.push(o);
  return { order: o };
}

export function sellPart(p, pos, fraction, px, why, now = Date.now()) {
  const frac = Math.min(fraction, pos.rem);
  if (frac <= 0) return null;
  const proceeds = pos.size * frac * (px / pos.entry) * (1 - p.settings.slip / 100);
  pos.rem -= frac;
  pos.realized += proceeds;
  p.cash += proceeds;
  const ev = { type: 'sell', symbol: pos.symbol, id: pos.id, frac, px, why, proceeds };
  if (pos.rem <= 1e-9) {
    p.positions = p.positions.filter((x) => x !== pos);
    const rec = { id: pos.id, symbol: pos.symbol, token: pos.token, size: pos.size, realized: pos.realized, pnl: pos.realized - pos.size, x: pos.realized / pos.size, openedAt: pos.openedAt, closedAt: now, why };
    p.closed.unshift(rec);
    p.closed = p.closed.slice(0, 50);
    ev.closed = rec;
  }
  return ev;
}

// mark one position to market and apply its rules
export function tickPosition(p, pos, q, now = Date.now()) {
  const evs = [];
  if (!q?.price) return evs;
  if (q.liq != null && q.liq < 500) {
    evs.push(sellPart(p, pos, pos.rem, q.price * 0.1, 'liquidity pulled (rug)', now));
    return evs.filter(Boolean);
  }
  pos.last = q.price;
  pos.peak = Math.max(pos.peak, q.price);
  const x = q.price / pos.entry;
  if (x <= 1 + pos.sl / 100) {
    evs.push(sellPart(p, pos, pos.rem, q.price, pos.sl === 0 ? 'breakeven stop' : `stop loss (${pos.sl}%)`, now));
    return evs.filter(Boolean);
  }
  for (const tp of pos.tps) {
    if (!tp.hit && x >= tp.x && pos.rem > 0) {
      tp.hit = true;
      evs.push(sellPart(p, pos, tp.sell / 100, q.price, `take profit ${tp.x}x`, now));
    }
  }
  if (pos.rem > 0 && x >= pos.runner) evs.push(sellPart(p, pos, pos.rem, q.price, `runner target ${pos.runner}x`, now));
  else if (pos.rem > 0 && pos.tps.some((t) => t.hit) && q.price <= pos.peak * (1 - pos.trail / 100)) {
    evs.push(sellPart(p, pos, pos.rem, q.price, `trailing stop (−${pos.trail}% from peak)`, now));
  }
  return evs.filter(Boolean);
}

export function tickOrders(p, prices, now = Date.now()) {
  const evs = [];
  for (const o of [...p.orders]) {
    const q = prices[o.pool];
    if (now > o.expiresAt) {
      p.orders = p.orders.filter((x) => x !== o);
      p.cash += o.size;
      evs.push({ type: 'expired', symbol: o.symbol, id: o.id, size: o.size });
    } else if (q?.price && q.price <= o.limit) {
      p.orders = p.orders.filter((x) => x !== o);
      p.cash += o.size;
      const r = openPosition(p, { token: o.token, symbol: o.symbol, pool: o.pool, px: o.limit, size: o.size }, now);
      evs.push({ type: 'filled', symbol: o.symbol, id: o.id, limit: o.limit, pos: r.pos });
    }
  }
  return evs;
}

// cron: mark everything to market, fill orders, apply TP/SL, report fills
export async function paperTick(env, now = Date.now()) {
  const p = await loadPaper(env);
  if (!p || (!p.positions.length && !p.orders.length)) return [];
  const prices = await priceMap(env, [...p.positions, ...p.orders]);
  const evs = [...tickOrders(p, prices, now)];
  for (const pos of [...p.positions]) evs.push(...tickPosition(p, pos, prices[pos.pool], now));
  const moves = positionMoves(p, prices, now);
  await savePaper(env, p);
  for (const e of evs) await reply(env, env.ALLOWED_CHAT_ID, eventText(e));
  for (const m of moves) {
    await tg(env, 'sendMessage', { chat_id: env.ALLOWED_CHAT_ID, text: moveText(m), reply_markup: { inline_keyboard: moveButtons(m.pos.id) }, disable_web_page_preview: true });
  }
  return [...evs, ...moves];
}

// ── live position updates: a message each time a trade's P/L crosses another step (default 10%)
// in either direction, so scalps and swings stay in the loop without opening the menu.
export function positionPnl(pos) {
  const value = posValue(pos) + pos.realized;
  return { value, pnl: value - pos.size, pct: ((value - pos.size) / pos.size) * 100 };
}

export function positionMoves(p, prices, now = Date.now()) {
  const step = Number(p.settings.moveStep) || 0;
  if (!step) return [];
  const out = [];
  for (const pos of p.positions) {
    if (!prices[pos.pool]?.price) continue; // no fresh price → no update
    const { pnl, pct } = positionPnl(pos);
    const band = Math.trunc(pct / step); // +10.3% → 1 · −24% → −2 · ±9% → 0
    if (pos.band == null) pos.band = 0;
    if (band !== pos.band) {
      out.push({ pos, pct, pnl, band, prevBand: pos.band, step, held: now - pos.openedAt, source: prices[pos.pool].source, ageMin: prices[pos.pool].ageMin });
      pos.band = band;
    }
  }
  return out;
}

const heldFor = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

export function moveText(m) {
  const { pos, pct, pnl, band, prevBand } = m;
  const up = band > prevBand;
  let head;
  if (band === 0) head = `${up ? '↗️' : '↘️'} $${pos.symbol} back near breakeven (${pctS(pct)}, ${signed(pnl)})`;
  else if (pct > 0) head = `${up ? '📈' : '📉'} $${pos.symbol} ${up ? 'up' : 'pulled back to'} ${pctS(pct)} (${signed(pnl)})`;
  else head = `${up ? '↗️' : '🔻'} $${pos.symbol} ${up ? 'recovering' : 'down'} ${pctS(pct)} (${signed(pnl)})`;
  const stopPx = pos.entry * (1 + pos.sl / 100);
  const lines = [
    head,
    `Entry ${price(pos.entry)} → now ${price(pos.last)} · ${Math.round(pos.rem * 100)}% still held, worth ${money(posValue(pos))}${pos.realized ? ` (+${money(pos.realized)} already taken)` : ''}`,
    `Held ${heldFor(m.held)} · stop ${price(stopPx)}${pos.tps.find((t) => !t.hit) ? ` · next target ${pos.tps.find((t) => !t.hit).x}x` : ''}`,
  ];
  if (m.source === 'scan') lines.push(`(price from the last scan${m.ageMin != null ? `, ${m.ageMin} min ago` : ''})`);
  return lines.join('\n');
}

const moveButtons = (id) => [
  [btn('Sell 25%', `px:${id}:25`), btn('Sell 50%', `px:${id}:50`), btn('Sell all', `px:${id}:100`)],
  [btn('SL → breakeven', `pS:${id}:0`), btn('📂 Position', `po:${id}`)],
];

function eventText(e) {
  if (e.type === 'filled') return `📝 Limit order filled · $${e.symbol}\nBought ${money(e.pos.size)} at ${price(e.limit)}. TP/SL are active — /paper → Positions.`;
  if (e.type === 'expired') return `⌛ Limit order expired · $${e.symbol}\nThe pullback never came. ${money(e.size)} is back in your cash.`;
  if (e.closed) {
    const r = e.closed;
    return `${r.pnl >= 0 ? '✅' : '❌'} Paper trade closed · $${r.symbol}\n${e.why}. Put in ${money(r.size)}, got back ${money(r.realized)} — ${r.pnl >= 0 ? 'profit' : 'loss'} ${money(Math.abs(r.pnl))} (${r.x.toFixed(2)}×).`;
  }
  return `📝 Paper trade · $${e.symbol}\n${e.why}: sold ${Math.round(e.frac * 100)}% at ${price(e.px)} → ${money(e.proceeds)} back to cash.`;
}

// ── screens (text + buttons). Every screen starts with "PAPER ·" so taps edit it in place.
const btn = (text, data) => ({ text, callback_data: data });
const BACK = [btn('⬅️ Menu', 'm')];
const needKV = { text: 'PAPER · setup needed\n\nPaper trading needs the KV step in worker/SETUP.md (Bindings → KV namespace named PAPER).', kb: [] };

export async function mainScreen(env) {
  const p = await loadPaper(env);
  if (!p) return needKV;
  const prices = p.positions.length ? await priceMap(env, p.positions) : {};
  for (const pos of p.positions) if (prices[pos.pool]?.price) pos.last = prices[pos.pool].price;
  const eq = equity(p);
  const text = [
    'PAPER · 📋 PAPER TRADING',
    '',
    `💰 Wallet ${money(eq)} (started ${money(p.start)}, ${pctS(((eq - p.start) / p.start) * 100)})`,
    `${money(p.cash)} cash · ${p.positions.length} open position(s) · ${p.orders.length} limit order(s)`,
    '',
    'Pick an option:',
  ].join('\n');
  const kb = [
    [btn('🛒 Place trade', 'pt'), btn('🎯 TP / SL', 'ts')],
    [btn('📂 Positions', 'pos'), btn('💰 Wallet', 'w')],
    [btn('📊 P/L', 'pnl'), btn('📜 Signals', 'sg:0:all')],
  ];
  return { text, kb };
}

const TIER = { buy: '🟢', pump: '🚀', watch: '👀', scored: '⚪', manual: '✍️' };

async function placeScreen(env) {
  const cands = (await candidates(env)).filter((c) => !c.washLikely).slice(0, 8);
  const text = [
    'PAPER · 🛒 PLACE TRADE',
    '',
    cands.length ? 'Coins the scanner analysed in the last 24h (best first):' : 'No analysed coins in the last 24h yet.',
    ...cands.map((c) => `${TIER[c.tier] || '•'} $${c.symbol} — ${c.tier === 'pump' ? 'pumping, pullback entry' : c.tier}${c.score != null ? ` · ${c.score}/100` : ''} · ${money(c.mcap)} mc`),
    '',
    'Or paste any contract address and tap 📝 Paper buy on the report.',
  ].join('\n');
  const kb = cands.map((c) => [btn(`${TIER[c.tier] || '•'} $${c.symbol}${c.score != null ? ` · ${c.score}` : ''}`, `pc:${c.token}`)]);
  kb.push(BACK);
  return { text, kb };
}

async function coinScreen(env, token) {
  const p = await loadPaper(env);
  if (!p) return needKV;
  const c = await coinInfo(env, token);
  if (!c) return { text: 'PAPER · coin not found\n\nCouldn\'t find a trading pool for that coin.', kb: [BACK] };
  const q = (await priceMap(env, [c]))[c.pool];
  const st = p.settings;
  const lines = [
    `PAPER · 🛒 BUY $${c.symbol}`,
    '',
    q?.price ? `Price ${price(q.price)} · market cap ${money(q.mcap ?? c.mcap)}${q.source === 'scan' ? ` (from the last scan${q.ageMin != null ? `, ${q.ageMin} min ago` : ''})` : ''}` : `⚠️ ${noPriceMsg()}`,
    (q?.mcap ?? c.mcap) ? `🎯 3x = ${money((q?.mcap ?? c.mcap) * 3)} mc · 10x = ${money((q?.mcap ?? c.mcap) * 10)} mc` : null,
    c.score != null ? `Scanner: ${c.tier} · ${c.score}/100` : null,
    c.entry ? `🚀 Pumping — suggested limit buy ${price(c.entry.mid)} (zone ${price(c.entry.top)} → ${price(c.entry.deep)}), stop ${price(c.entry.stop)}` : null,
    '',
    `Rules applied: stop ${st.sl}% · sell ${st.tp1Sell}% at ${st.tp1}x · ${st.tp2Sell}% at ${st.tp2}x · rest rides to ${st.runner}x (trail ${st.trail}%)`,
    `Cash available: ${money(p.cash)} · ${st.slip}% slippage assumed`,
    '',
    'How much?',
  ].filter((l) => l !== null);
  const part = (pct) => `${pct}% (${money(sizeFor(p.cash, pct))})`;
  const kb = [
    [btn(part(5), `pb:${token}:p5`), btn(part(10), `pb:${token}:p10`)],
    [btn(part(25), `pb:${token}:q`), btn(part(50), `pb:${token}:p50`), btn(`All (${money(p.cash)})`, `pb:${token}:all`)],
  ];
  if (c.entry?.mid) kb.push([btn(`📌 Limit buy ${st.sizePct}% (${money(sizeFor(p.cash, st.sizePct))}) @ ${price(c.entry.mid)}`, `pl:${token}`)]);
  kb.push([btn('⬅️ Back', 'pt'), ...BACK]);
  return { text: lines.join('\n'), kb };
}

function tpslScreen(p) {
  const st = p.settings;
  const mark = (cur, v) => (cur === v ? '✅ ' : '');
  const text = [
    'PAPER · 🎯 TP / SL (for new trades)',
    '',
    `Stop loss: ${st.sl}%`,
    `Take profit 1: sell ${st.tp1Sell}% at ${st.tp1}x`,
    `Take profit 2: sell ${st.tp2Sell}% at ${st.tp2}x`,
    `Runner: rest sells at ${st.runner}x, or if it drops ${st.trail}% from its peak after TP1`,
    `Default size for limit buys: ${st.sizePct}% of cash`,
    `Position updates: ${Number(st.moveStep) ? `every ${st.moveStep}% move (up or down)` : 'off'}`,
    '',
    'Change an open trade\'s TP/SL under 📂 Positions.',
  ].join('\n');
  const kb = [
    [-25, -35, -50].map((v) => btn(`${mark(st.sl, v)}SL ${v}%`, `ss:${v}`)),
    [2, 3, 4].map((v) => btn(`${mark(st.tp1, v)}TP1 ${v}x`, `st:${v}`)),
    [5, 10, 20].map((v) => btn(`${mark(st.runner, v)}Runner ${v}x`, `sr:${v}`)),
    [5, 10, 25].map((v) => btn(`${mark(st.sizePct, v)}Size ${v}%`, `sz:${v}`)),
    [...[5, 10, 20].map((v) => btn(`${mark(Number(st.moveStep), v)}Updates ${v}%`, `sm:${v}`)), btn(`${mark(Number(st.moveStep), 0)}Off`, 'sm:0')],
    BACK,
  ];
  return { text, kb };
}

async function positionsScreen(env) {
  const p = await loadPaper(env);
  if (!p) return needKV;
  const prices = await priceMap(env, [...p.positions, ...p.orders]);
  const lines = ['PAPER · 📂 POSITIONS', ''];
  if (!p.positions.length) lines.push('No open positions.');
  for (const pos of p.positions) {
    if (prices[pos.pool]?.price) pos.last = prices[pos.pool].price;
    const x = pos.last / pos.entry;
    const val = posValue(pos);
    const next = pos.tps.find((t) => !t.hit);
    lines.push(`#${pos.id} $${pos.symbol} — ${x.toFixed(2)}× · worth ${money(val)} (${signed(val + pos.realized - pos.size)})`);
    lines.push(`   stop ${pos.sl === 0 ? 'breakeven' : `${pos.sl}%`} · ${next ? `next TP ${next.x}x` : `riding to ${pos.runner}x`} · ${Math.round(pos.rem * 100)}% left`);
  }
  if (p.orders.length) {
    lines.push('', '📌 Limit orders');
    for (const o of p.orders) {
      const now = prices[o.pool]?.price;
      lines.push(`#${o.id} $${o.symbol} — buy ${money(o.size)} at ${price(o.limit)}${now ? ` (now ${price(now)}, ${Math.round((now / o.limit - 1) * 100)}% away)` : ''} · expires in ${Math.max(0, Math.round((o.expiresAt - Date.now()) / 3_600_000))}h`);
    }
  }
  const kb = [
    ...p.positions.map((pos) => [btn(`#${pos.id} $${pos.symbol} — manage`, `po:${pos.id}`)]),
    ...p.orders.map((o) => [btn(`✖ Cancel order #${o.id} $${o.symbol}`, `oc:${o.id}`)]),
    [btn('🔄 Refresh', 'pos'), ...BACK],
  ];
  return { text: lines.join('\n'), kb };
}

function positionScreen(p, id) {
  const pos = p.positions.find((x) => x.id === id);
  if (!pos) return { text: 'PAPER · position closed\n\nThat position is no longer open.', kb: [[btn('📂 Positions', 'pos'), ...BACK]] };
  const x = pos.last / pos.entry;
  const text = [
    `PAPER · #${pos.id} $${pos.symbol}`,
    '',
    `Entry ${price(pos.entry)} · now ${price(pos.last)} (${x.toFixed(2)}×) · peak ${price(pos.peak)}`,
    `Put in ${money(pos.size)} · ${Math.round(pos.rem * 100)}% still held, worth ${money(posValue(pos))} · already took ${money(pos.realized)}`,
    `Stop: ${pos.sl === 0 ? 'breakeven' : `${pos.sl}%`} (${price(pos.entry * (1 + pos.sl / 100))})`,
    `Targets: ${pos.tps.map((t) => `${t.hit ? '✅' : '◻️'} ${t.x}x sell ${t.sell}%`).join(' · ')} · runner ${pos.runner}x`,
  ].join('\n');
  const kb = [
    [btn('Sell 25%', `px:${id}:25`), btn('Sell 50%', `px:${id}:50`), btn('Sell all', `px:${id}:100`)],
    [btn('SL breakeven', `pS:${id}:0`), btn('SL −25%', `pS:${id}:-25`), btn('SL −50%', `pS:${id}:-50`)],
    [btn('TP1 2x', `pT:${id}:2`), btn('TP1 3x', `pT:${id}:3`), btn('TP1 5x', `pT:${id}:5`)],
    [btn('⬅️ Positions', 'pos'), ...BACK],
  ];
  return { text, kb };
}

async function walletScreen(env) {
  const p = await loadPaper(env);
  if (!p) return needKV;
  const prices = p.positions.length ? await priceMap(env, p.positions) : {};
  for (const pos of p.positions) if (prices[pos.pool]?.price) pos.last = prices[pos.pool].price;
  const inPos = p.positions.reduce((s, x) => s + posValue(x), 0);
  const eq = equity(p);
  const text = [
    'PAPER · 💰 WALLET',
    '',
    `Total value: ${money(eq)}`,
    `• Cash: ${money(p.cash)}`,
    `• In open positions: ${money(inPos)} (${p.positions.length})`,
    `• Reserved for limit orders: ${money(reserved(p))} (${p.orders.length})`,
    '',
    `Started with ${money(p.start)} on ${new Date(p.createdAt).toISOString().slice(0, 10)} → ${pctS(((eq - p.start) / p.start) * 100)}`,
  ].join('\n');
  return { text, kb: [[btn('🔄 Reset / change starting amount', 'wr')], BACK] };
}

async function pnlScreen(env) {
  const p = await loadPaper(env);
  if (!p) return needKV;
  const prices = p.positions.length ? await priceMap(env, p.positions) : {};
  for (const pos of p.positions) if (prices[pos.pool]?.price) pos.last = prices[pos.pool].price;
  const realized = p.closed.reduce((s, r) => s + r.pnl, 0) + p.positions.reduce((s, x) => s + x.realized - x.size * (1 - x.rem), 0);
  const unrealized = p.positions.reduce((s, x) => s + posValue(x) - x.size * x.rem, 0);
  const wins = p.closed.filter((r) => r.pnl > 0);
  const best = [...p.closed].sort((a, b) => b.x - a.x)[0];
  const worst = [...p.closed].sort((a, b) => a.x - b.x)[0];
  const lines = [
    'PAPER · 📊 PROFIT / LOSS',
    '',
    `Total: ${signed(realized + unrealized)}`,
    `• Locked in (sold): ${signed(realized)}`,
    `• Open (not sold yet): ${signed(unrealized)}`,
    '',
    p.closed.length ? `${p.closed.length} closed trade(s) · ${wins.length} winner(s) (${Math.round((wins.length / p.closed.length) * 100)}%) · ${p.closed.filter((r) => r.x >= 3).length} hit 3x+` : 'No closed trades yet.',
    best ? `Best: $${best.symbol} ${best.x.toFixed(2)}× · Worst: $${worst.symbol} ${worst.x.toFixed(2)}×` : null,
  ];
  if (p.closed.length) {
    lines.push('', 'Last trades:');
    for (const r of p.closed.slice(0, 5)) lines.push(`${r.pnl >= 0 ? '✅' : '❌'} $${r.symbol} ${money(r.size)} → ${money(r.realized)} (${r.x.toFixed(2)}×) — ${r.why}`);
  }
  return { text: lines.filter((l) => l !== null).join('\n'), kb: [BACK] };
}

// ════════════════════════════════════════════════════════════
//  SIGNALS — every coin the scanner has called, in one list (/signals)
// ════════════════════════════════════════════════════════════
const SIG_ICON = { watch: '👀', buy: '🟢', ignition: '🔥', pump: '🚀' };
const SIG_NAME = { watch: 'Watch', buy: 'Buy zone', ignition: 'Ignition', pump: 'Pumping' };
const SIG_ORDER = ['watch', 'buy', 'ignition', 'pump'];
const SIG_PER_PAGE = 6;
const SIG_FILTERS = { all: 'All', buy: '🟢 Buy', ignition: '🔥 Ignition', watch: '👀 Watch', win: '✅ Hit 3x' };

export const when = (ms) =>
  new Date(ms).toLocaleString('en-US', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

async function rawJson(env, file) {
  const res = await fetch(`https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/data/${file}?t=${Math.floor(Date.now() / 60000)}`, { headers: { 'cache-control': 'no-cache' } });
  return res.ok ? res.json() : null;
}

// Did it do what we want (3x from the first call before −50%)?
export function signalStatus(e) {
  if (!e) return { icon: '·', text: 'price not recorded (called before tracking started)' };
  if (e.outcome === 'win') return { icon: '✅', text: `hit 3x (peak ${e.peakX.toFixed(2)}×)` };
  if (e.outcome === 'stopped') return { icon: '❌', text: `fell 50% before 3x (peak ${e.peakX.toFixed(2)}×)` };
  if (e.outcome === 'expired') return { icon: '⏹', text: `30 days up, ended ${e.lastX.toFixed(2)}× (peak ${e.peakX.toFixed(2)}×)` };
  if (e.peakX >= 2) return { icon: '🚀', text: `on track — touched ${e.peakX.toFixed(2)}×, now ${e.lastX.toFixed(2)}×` };
  if (e.lastX >= 1.2) return { icon: '📈', text: `up — now ${e.lastX.toFixed(2)}× (peak ${e.peakX.toFixed(2)}×)` };
  if (e.lastX <= 0.75) return { icon: '📉', text: `down — now ${e.lastX.toFixed(2)}× (low ${e.lowX.toFixed(2)}×)` };
  return { icon: '➖', text: `flat — now ${e.lastX.toFixed(2)}× (peak ${e.peakX.toFixed(2)}×)` };
}

// state.json (+ prices.json for market caps) → one row per coin, newest signal first
export function buildSignals(state, prices = null) {
  const by = new Map();
  const coin = (token, symbol) => {
    if (!by.has(token)) by.set(token, { token, symbol, events: [] });
    return by.get(token);
  };
  for (const a of state.scorecard || []) {
    let mcap = a.mcap;
    const row = prices?.p?.[a.token];
    if (!mcap && row?.[0] > 0 && row[1]) mcap = (row[1] * a.price) / row[0]; // back out the cap at the call
    coin(a.token, a.symbol).events.push({ tier: a.tier, at: a.at, price: a.price, mcap, score: a.score, entry: a, lane: a.lane, kind: a.kind });
  }
  // alerts from before the scorecard existed (time only)
  for (const [store, tier] of [[state.watchAlerts, 'watch'], [state.alerts, 'buy'], [state.ignitionAlerts, 'ignition'], [state.pumpAlerts, 'pump']]) {
    for (const [token, v] of Object.entries(store || {})) {
      const c = coin(token, v.symbol);
      if (!c.events.some((e) => e.tier === tier && Math.abs(e.at - v.at) < 3_600_000)) c.events.push({ tier, at: v.at, score: v.score ?? null, legacy: true });
    }
  }
  const out = [];
  for (const c of by.values()) {
    c.events.sort((x, y) => x.at - y.at);
    c.first = c.events.find((e) => e.price) || c.events[0]; // outcome is measured from the first PRICED call
    c.earliest = c.events[0];
    c.pool = c.events.find((e) => e.entry?.pool)?.entry.pool || prices?.p?.[c.token]?.[3] || null;
    c.lastAt = c.events.at(-1).at;
    c.firstOf = Object.fromEntries(SIG_ORDER.map((t) => [t, c.events.find((e) => e.tier === t) || null]));
    c.status = signalStatus(c.first.entry);
    out.push(c);
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

function filterSignals(list, f) {
  if (f === 'win') return list.filter((c) => c.first.entry?.outcome === 'win' || c.first.entry?.peakX >= 3);
  if (SIG_ICON[f]) return list.filter((c) => c.firstOf[f]);
  return list;
}

async function loadSignals(env) {
  const [state, prices] = await Promise.all([rawJson(env, 'state.json'), rawJson(env, 'prices.json').catch(() => null)]);
  if (!state) throw new Error("couldn't read the bot's data");
  return buildSignals(state, prices);
}

export async function signalsScreen(env, page = 0, f = 'all') {
  const all = await loadSignals(env);
  const list = filterSignals(all, f);
  const pages = Math.max(1, Math.ceil(list.length / SIG_PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(page * SIG_PER_PAGE, (page + 1) * SIG_PER_PAGE);
  const wins = all.filter((c) => c.first.entry?.outcome === 'win').length;
  const tracked = all.filter((c) => c.first.entry).length;
  const L = [`SIGNALS · 📜 ${SIG_FILTERS[f] || 'All'} — ${list.length} coin(s)`, `Goal: 3x from the first call before −50%. ✅ ${wins} of ${tracked} tracked so far.`, ''];
  if (!slice.length) L.push('Nothing here yet.');
  for (const c of slice) {
    const f0 = c.first;
    L.push(`${c.status.icon} $${c.symbol} — first called ${when(c.earliest.at)}${c.earliest === f0 && f0.price ? ` at ${money(f0.mcap)} mc` : ''}`);
    if (c.earliest !== f0 && f0.price) L.push(`   tracked from ${when(f0.at)} at ${money(f0.mcap)} mc`);
    const times = SIG_ORDER.filter((t) => c.firstOf[t]).map((t) => `${SIG_ICON[t]} ${when(c.firstOf[t].at)}`);
    L.push(`   ${times.join(' · ')}`);
    L.push(`   ${c.status.text}`);
    L.push('');
  }
  L.push('Tap a coin for its full timeline.');
  const kb = [];
  for (let i = 0; i < slice.length; i += 2) kb.push(slice.slice(i, i + 2).map((c) => btn(`${c.status.icon} $${c.symbol}`, `sd:${c.token}`)));
  kb.push(Object.entries(SIG_FILTERS).filter(([k]) => k !== f).slice(0, 4).map(([k, label]) => btn(label, `sg:0:${k}`)));
  const nav = [];
  if (page > 0) nav.push(btn('◀️ Newer', `sg:${page - 1}:${f}`));
  nav.push(btn(`${page + 1}/${pages} 🔄`, `sg:${page}:${f}`));
  if (page < pages - 1) nav.push(btn('Older ▶️', `sg:${page + 1}:${f}`));
  kb.push(nav);
  return { text: L.join('\n'), kb };
}

export async function signalDetail(env, token) {
  const c = (await loadSignals(env)).find((x) => x.token === token);
  if (!c) return { text: 'SIGNALS · not found\n\nThat coin has no recorded signals.', kb: [[btn('⬅️ Signals', 'sg:0:all')]] };
  const L = [`SIGNALS · ${c.status.icon} $${c.symbol}`, ''];
  const lane = c.events.find((e) => e.lane)?.lane;
  const kind = c.events.find((e) => e.kind)?.kind;
  if (lane || kind) L.push(`${lane === 'quality' ? '🏛 Quality lane' : lane === 'micro' ? '🧪 Micro lane' : ''}${kind === 'utility' ? ' · 🛠 Utility' : ''}`.trim(), '');
  L.push(`Outcome so far: ${c.status.text}`, '', '🕒 TIMELINE (Toronto time)');
  for (const e of c.events) {
    const bits = [`${SIG_ICON[e.tier] || '•'} ${SIG_NAME[e.tier] || e.tier} — ${when(e.at)}`];
    if (e.price) bits.push(`at ${price(e.price)}${e.mcap ? ` · ${money(e.mcap)} mc` : ''}`);
    if (e.score != null) bits.push(`score ${e.score}`);
    L.push(bits.join(' · '));
    if (e.entry && e.entry !== c.first.entry) L.push(`   from this call: now ${e.entry.lastX.toFixed(2)}× · peak ${e.entry.peakX.toFixed(2)}×${e.entry.outcome ? ` · ${e.entry.outcome}` : ''}`);
    if (e.legacy) L.push('   (called before price tracking started)');
  }
  const pool = c.pool;
  if (pool) L.push('', `Chart: https://www.geckoterminal.com/robinhood/pools/${pool}`);
  L.push(`CA: ${c.token}`);
  return { text: L.join('\n'), kb: [[btn('📝 Paper buy', `pc:${c.token}`)], [btn('⬅️ Signals', 'sg:0:all')]] };
}

async function sendScreen(env, chatId, scr) {
  return tg(env, 'sendMessage', { chat_id: chatId, text: scr.text, reply_markup: { inline_keyboard: scr.kb }, disable_web_page_preview: true });
}

// ── button taps ─────────────────────────────────────────────
export async function handleCallback(env, cq) {
  priceErrors.length = 0;
  const chatId = cq.message?.chat?.id;
  if (String(chatId) !== String(env.ALLOWED_CHAT_ID)) return;
  const data = cq.data || '';
  const [op, a, b, c2] = data.split(':');
  const b2 = b;
  let scr = null;
  let toast = '';

  const fxOps = ['fx', 'fxp', 'fxc', 'fxn', 'fxd', 'fxr', 'fxb'];
  const isBudget = /^bg[a-z]?$/.test(op);
  const p = op === 'sg' || op === 'sd' || fxOps.includes(op) || isBudget ? null : await loadPaper(env);
  if (isBudget) {
    if (!env.PAPER) scr = needKV;
    else {
      const b = await BG.loadBudget(env);
      scr = BG.handleTap(b, op, a, b2, c2);
      await BG.saveBudget(env, b);
    }
  } else if (op === 'fx') scr = await fxMenu(env);
  else if (op === 'fxp') scr = await fxPairScreen(env, a);
  else if (op === 'fxc') scr = await fxCalendarScreen(env, a || 'today');
  else if (op === 'fxn') scr = await fxHeadlinesScreen(env, a || 'all');
  else if (op === 'fxd') scr = await fxDriversScreen(env);
  else if (op === 'fxr') scr = await fxRecordScreen(env);
  else if (op === 'fxb') {
    const r = await dispatch(env, 'fx.yml', { mode: 'brief' });
    toast = r.ok ? 'Full FX brief started — arrives in 1–2 min' : `Couldn't start it: ${dispatchError(r)}`;
  } else if (op === 'sg') scr = await signalsScreen(env, Number(a) || 0, b || 'all');
  else if (op === 'sd') scr = await signalDetail(env, a);
  else if (!p) {
    scr = needKV;
  } else if (op === 'm') scr = await mainScreen(env);
  else if (op === 'pt') scr = await placeScreen(env);
  else if (op === 'pc') scr = await coinScreen(env, a);
  else if (op === 'ts') scr = tpslScreen(p);
  else if (op === 'pos') scr = await positionsScreen(env);
  else if (op === 'w') scr = await walletScreen(env);
  else if (op === 'pnl') scr = await pnlScreen(env);
  else if (op === 'po') {
    const prices = await priceMap(env, p.positions);
    for (const pos of p.positions) if (prices[pos.pool]?.price) pos.last = prices[pos.pool].price;
    scr = positionScreen(p, Number(a));
  } else if (op === 'pb') {
    const c = await coinInfo(env, a);
    const q = c ? (await priceMap(env, [{ ...c, token: a }]))[c.pool] : null;
    const size = b === 'all' ? Math.floor(p.cash * 100) / 100 : b === 'q' ? sizeFor(p.cash, 25) : /^p\d+$/.test(b) ? sizeFor(p.cash, Number(b.slice(1))) : Number(b);
    const r = !c ? { error: 'Coin not found.' } : !q?.price ? { error: noPriceMsg() } : openPosition(p, { token: a, symbol: c.symbol, pool: c.pool, px: q.price, size });
    if (r.error) toast = r.error;
    else {
      await savePaper(env, p);
      toast = `Bought ${money(size)} of $${c.symbol}`;
      scr = positionScreen(p, r.pos.id);
    }
  } else if (op === 'pl') {
    const c = await coinInfo(env, a);
    const r = c?.entry?.mid ? placeOrder(p, { token: a, symbol: c.symbol, pool: c.pool, limit: c.entry.mid, size: sizeFor(p.cash, p.settings.sizePct) }) : { error: 'No pullback entry for this coin.' };
    if (r.error) toast = r.error;
    else {
      await savePaper(env, p);
      toast = `Limit buy placed at ${price(c.entry.mid)}`;
      scr = await positionsScreen(env);
    }
  } else if (op === 'oc') {
    const o = p.orders.find((x) => x.id === Number(a));
    if (o) {
      p.orders = p.orders.filter((x) => x !== o);
      p.cash += o.size;
      await savePaper(env, p);
      toast = `Order #${o.id} cancelled`;
    }
    scr = await positionsScreen(env);
  } else if (op === 'px') {
    const pos = p.positions.find((x) => x.id === Number(a));
    const q = pos ? (await priceMap(env, [pos]))[pos.pool] : null;
    if (pos && q?.price) {
      pos.last = q.price;
      const ev = sellPart(p, pos, Number(b) >= 100 ? pos.rem : Number(b) / 100, q.price, 'sold manually');
      await savePaper(env, p);
      toast = `Sold → ${money(ev.proceeds)}`;
      scr = ev.closed ? await positionsScreen(env) : positionScreen(p, pos.id);
    } else toast = noPriceMsg();
  } else if (op === 'pS' || op === 'pT') {
    const pos = p.positions.find((x) => x.id === Number(a));
    if (pos) {
      if (op === 'pS') pos.sl = Number(b);
      else pos.tps[0] = { ...pos.tps[0], x: Number(b), hit: false };
      await savePaper(env, p);
      toast = op === 'pS' ? `Stop set to ${Number(b) === 0 ? 'breakeven' : `${b}%`}` : `TP1 set to ${b}x`;
    }
    scr = positionScreen(p, Number(a));
  } else if (['ss', 'st', 'sr', 'sz', 'sm'].includes(op)) {
    const key = { ss: 'sl', st: 'tp1', sr: 'runner', sz: 'sizePct', sm: 'moveStep' }[op];
    p.settings[key] = Number(a);
    await savePaper(env, p);
    toast = 'Saved';
    scr = tpslScreen(p);
  } else if (op === 'wr') {
    scr = {
      text: 'PAPER · 🔄 RESET?\n\nThis wipes all paper positions, orders and history. Pick the amount to start again with:',
      kb: [START_AMOUNTS.map((v) => btn(money(v), `wry:${v}`)), [btn('Cancel', 'w')]],
    };
  } else if (op === 'wry') {
    const start = START_AMOUNTS.includes(Number(a)) ? Number(a) : DEFAULTS.start;
    await savePaper(env, freshPaper(Date.now(), start));
    toast = `Wallet reset to ${money(start)}`;
    scr = await mainScreen(env);
  }

  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: toast.slice(0, 190) });
  if (!scr) return;
  // menus edit themselves in place; taps on scanner alerts open a fresh menu message
  if (/^(PAPER|SIGNALS|FX|BUDGET) ·/.test(cq.message?.text || '')) {
    await tg(env, 'editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: scr.text, reply_markup: { inline_keyboard: scr.kb }, disable_web_page_preview: true });
  } else {
    await sendScreen(env, chatId, scr);
  }
}

export default {
  // Cloudflare Cron Triggers — reliable clock (GitHub schedules can lag for hours)
  async scheduled(event, env, ctx) {
    // Clock: this fires every 5 min. Paper positions (TP/SL + move updates) every 5 min;
    // a scan every 15 min; the holder-list job every 30 min; research daily; FX desk on its own clock.
    const minute = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
    const fxJob = event.cron === '23 14 * * *' ? null : fxClock(event.scheduledTime || Date.now());
    if (event.cron !== '23 14 * * *' && budgetClock(event.scheduledTime || Date.now()) && env.PAPER) ctx.waitUntil(budgetTick(env).catch(() => {}));
    if (fxJob) ctx.waitUntil(dispatch(env, 'fx.yml', { mode: fxJob }).catch(() => {}));
    const job = event.cron === '23 14 * * *' ? 'research.yml' : 'scan.yml';
    if (job === 'scan.yml' && env.PAPER) ctx.waitUntil(paperTick(env).catch(() => {}));
    // older 15-min cron setups dispatch every time; the 5-min cron only on quarter hours
    if (job === 'scan.yml' && event.cron === '*/5 * * * *' && minute % 15 >= 5) return;
    if (job === 'scan.yml' && minute % 30 < 15) ctx.waitUntil(dispatch(env, 'holders.yml').catch(() => {}));
    ctx.waitUntil(
      dispatch(env, job).then(async (r) => {
        // only speak up if the clock breaks, so a bad token doesn't fail silently
        if (!r.ok && env.ALLOWED_CHAT_ID) await reply(env, env.ALLOWED_CHAT_ID, `⏰ Scheduled ${job.replace('.yml', '')} couldn't start. ${dispatchError(r)}`);
      })
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // one-time setup: registers this Worker as the bot's webhook + command menu
    if (request.method === 'GET' && url.pathname === '/setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
      const hook = await tg(env, 'setWebhook', {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      });
      const cmds = await tg(env, 'setMyCommands', { commands: COMMANDS });
      const ok = hook.ok && cmds.ok;
      return new Response(
        ok ? '✅ Telegram is connected. Open your bot and send /help.' : `❌ Setup failed: ${JSON.stringify({ hook, cmds })}`,
        { status: ok ? 200 : 500, headers: { 'content-type': 'text/plain; charset=utf-8' } }
      );
    }

    if (request.method === 'POST' && url.pathname === '/telegram') {
      // only Telegram knows the secret — anything else is dropped
      if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
      const update = await request.json().catch(() => null);
      if (update?.message) {
        try {
          await handleMessage(env, update.message);
        } catch (e) {
          await reply(env, update.message.chat?.id, `❌ Something went wrong: ${String(e.message).slice(0, 150)}`).catch(() => {});
        }
      }
      if (update?.callback_query) {
        try {
          await handleCallback(env, update.callback_query);
        } catch (e) {
          await tg(env, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: `Error: ${String(e.message).slice(0, 150)}` }).catch(() => {});
        }
      }
      return new Response('ok'); // always 200 so Telegram doesn't retry
    }

    return new Response('hood-scanner bot is running', { status: 200 });
  },
};
