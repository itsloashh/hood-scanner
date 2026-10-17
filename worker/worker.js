// HOOD SCANNER — Telegram command relay (Cloudflare Worker, free plan)
//
// Telegram → this Worker → GitHub Actions. Commands:
//   /scan               run a full scan now
//   /check <address>    full report on one coin (or just paste an address)
//   /research           run the research job now
//   /status             last scan, bankroll and open paper trades (instant)
//   /help               list commands
//
// Settings → Variables and Secrets (all as "Secret" except GITHUB_REPO):
//   TELEGRAM_BOT_TOKEN  your bot token from BotFather
//   ALLOWED_CHAT_ID     your Telegram chat id — only this chat can use the bot
//   GITHUB_TOKEN        fine-grained token: hood-scanner repo, Actions = Read and write
//   WEBHOOK_SECRET      any random 20+ letters/numbers you make up
//   GITHUB_REPO         itsloashh/hood-scanner   (plain text variable)
//
// After deploying, open:  https://<your-worker>.workers.dev/setup?key=<WEBHOOK_SECRET>

const ADDR = /^0x[0-9a-fA-F]{40}$/;

const HELP = [
  '🤖 HOOD SCANNER commands',
  '',
  '/scan — run a full scan now (results in ~4 min)',
  '/check 0x… — full report on one coin, even if it fails your rules',
  '   (or just paste a contract address)',
  '/research — run the research job now (10–30 min)',
  '/status — last scan + paper bankroll, instantly',
  '/help — this list',
  '',
  'Alerts only arrive when a coin qualifies — a quiet scan sends nothing.',
].join('\n');

const COMMANDS = [
  { command: 'scan', description: 'Run a full scan now' },
  { command: 'check', description: 'Check one coin: /check 0x…' },
  { command: 'research', description: 'Run the research job now' },
  { command: 'status', description: 'Last scan + paper bankroll' },
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
  const p = s.paper || {};
  const L = ['📍 STATUS'];
  L.push(`Last scan: ${mins == null ? 'unknown' : mins < 1 ? 'just now' : `${mins} min ago`}`);
  if (r.scanned != null) L.push(`${r.scanned} coins → ${r.quickPass} survived the junk filter → ${r.deepPass} passed the full check`);
  if (r.buy != null) L.push(`That scan sent: ${r.buy} buy-zone, ${r.watch} watch alert(s)`);
  if (r.regime) L.push(`Market: ${{ 'risk-on': 'heating up', 'risk-off': 'cooling off', neutral: 'normal' }[r.regime] || r.regime}`);
  L.push('', `💵 Paper cash ${usd(p.cash)} · ${(p.positions || []).length} open trade(s)`);
  for (const pos of p.positions || []) {
    const x = pos.entryPrice ? (pos.lastPrice || pos.entryPrice) / pos.entryPrice : 1;
    L.push(`   – $${pos.symbol}: ${x.toFixed(2)}× since entry (${usd(pos.sizeUsd)} in)`);
  }
  const closed = p.closed || [];
  if (closed.length) {
    const wins = closed.filter((t) => t.pnl > 0).length;
    L.push(`Closed: ${closed.length} · ${wins} winner(s)`);
  }
  if (r.wallets) L.push('', `🧠 Tracking ${r.wallets.tracked} wallets · ${r.wallets.smart} smart`);
  if (r.httpErrors && Object.keys(r.httpErrors).length) {
    L.push('', `⚠️ Data source errors: ${Object.entries(r.httpErrors).map(([h, e]) => `${h.split('.')[0]} ${e.last}`).join(', ')}`);
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

  if (cmd === '/status') return reply(env, chatId, await status(env).catch((e) => `Couldn't read status: ${e.message}`));

  return reply(env, chatId, `Didn't catch that.\n\n${HELP}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // one-time setup: registers this Worker as the bot's webhook + command menu
    if (request.method === 'GET' && url.pathname === '/setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
      const hook = await tg(env, 'setWebhook', {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message'],
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
      return new Response('ok'); // always 200 so Telegram doesn't retry
    }

    return new Response('hood-scanner bot is running', { status: 200 });
  },
};
