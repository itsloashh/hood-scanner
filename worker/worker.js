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
  '/status — what the last scan found, instantly',
  '/help — this list',
  '',
  'Alerts only arrive when a coin qualifies — a quiet scan sends nothing.',
].join('\n');

const COMMANDS = [
  { command: 'scan', description: 'Run a full scan now' },
  { command: 'check', description: 'Check one coin: /check 0x…' },
  { command: 'research', description: 'Run the research job now' },
  { command: 'catalyst', description: 'Tag a coin with news: /catalyst 0x… listing' },
  { command: 'paper', description: 'Paper trading menu' },
  { command: 'status', description: 'What the last scan found' },
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
  const text = (msg.text || '').trim();
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, ''); // /scan@MyBot → /scan

  // pasted contract address = /check
  if (ADDR.test(rawCmd)) return handleMessage(env, { ...msg, text: `/check ${rawCmd}` });

  if (cmd === '/start' || cmd === '/help') return reply(env, chatId, HELP);

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

  if (cmd === '/paper') return sendScreen(env, chatId, await mainScreen(env));

  if (cmd === '/status') return reply(env, chatId, await status(env).catch((e) => `Couldn't read status: ${e.message}`));

  return reply(env, chatId, `Didn't catch that.\n\n${HELP}`);
}


// ════════════════════════════════════════════════════════════
//  PAPER TRADING (Telegram buttons + KV)
// ════════════════════════════════════════════════════════════
const GT = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
const DEFAULTS = { start: 30, sizePct: 10, sl: -50, tp1: 3, tp1Sell: 50, tp2: 5, tp2Sell: 25, runner: 10, trail: 40, slip: 3, orderHours: 48 };
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
  await savePaper(env, p);
  for (const e of evs) await reply(env, env.ALLOWED_CHAT_ID, eventText(e));
  return evs;
}

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
    [btn('📊 P/L', 'pnl')],
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
    '',
    'Change an open trade\'s TP/SL under 📂 Positions.',
  ].join('\n');
  const kb = [
    [-25, -35, -50].map((v) => btn(`${mark(st.sl, v)}SL ${v}%`, `ss:${v}`)),
    [2, 3, 4].map((v) => btn(`${mark(st.tp1, v)}TP1 ${v}x`, `st:${v}`)),
    [5, 10, 20].map((v) => btn(`${mark(st.runner, v)}Runner ${v}x`, `sr:${v}`)),
    [5, 10, 25].map((v) => btn(`${mark(st.sizePct, v)}Size ${v}%`, `sz:${v}`)),
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

async function sendScreen(env, chatId, scr) {
  return tg(env, 'sendMessage', { chat_id: chatId, text: scr.text, reply_markup: { inline_keyboard: scr.kb }, disable_web_page_preview: true });
}

// ── button taps ─────────────────────────────────────────────
export async function handleCallback(env, cq) {
  priceErrors.length = 0;
  const chatId = cq.message?.chat?.id;
  if (String(chatId) !== String(env.ALLOWED_CHAT_ID)) return;
  const data = cq.data || '';
  const [op, a, b] = data.split(':');
  let scr = null;
  let toast = '';

  const p = await loadPaper(env);
  if (!p) {
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
  } else if (['ss', 'st', 'sr', 'sz'].includes(op)) {
    const key = { ss: 'sl', st: 'tp1', sr: 'runner', sz: 'sizePct' }[op];
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
  if ((cq.message?.text || '').startsWith('PAPER ·')) {
    await tg(env, 'editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: scr.text, reply_markup: { inline_keyboard: scr.kb }, disable_web_page_preview: true });
  } else {
    await sendScreen(env, chatId, scr);
  }
}

export default {
  // Cloudflare Cron Triggers — reliable clock (GitHub schedules can lag for hours)
  async scheduled(event, env, ctx) {
    const job = event.cron === '23 14 * * *' ? 'research.yml' : 'scan.yml';
    if (job === 'scan.yml' && env.PAPER) ctx.waitUntil(paperTick(env).catch(() => {}));
    // every 30 min: the slow Blockscout holder-list job (GitHub's own schedule is unreliable)
    const minute = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
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
