// Alerts to your phone: the Hood Desk app (inbox + push, via the bot Worker's hub), Telegram and/or Discord.
// With nothing configured (or DRY_RUN=1) messages just print to the log.
import crypto from 'node:crypto';

// What kind of message this is, and which Hood Desk page it opens
export function eventFor(text, buttons = null, { kind = null, url = null, source = null } = {}) {
  const lines = String(text).split('\n');
  const i = lines.findIndex((l) => l.trim());
  const title = (lines[i] || 'Update').trim();
  const token = (buttons || []).flat().map((b) => b.data || '').join(' ').match(/:(0x[0-9a-fA-F]{40})\b/)?.[1];
  const script = String(process.argv[1] || '');
  const src = source || (/[\\/]fx[\\/]/.test(script) ? 'fx' : /[\\/]research[\\/]/.test(script) ? 'research' : /catalyst/.test(script) ? 'catalyst' : 'scan');
  const guess = [
    [/BUY ZONE/, 'coin-buy'], [/WATCH/, 'coin-watch'], [/PUMPING/, 'coin-pump'], [/IGNITION/, 'coin-ignition'],
    [/summary/i, 'digest'], [/CHECK/, 'coin-check'], [/Catalyst/i, 'catalyst'],
  ].find(([re]) => re.test(title))?.[1];
  return {
    kind: kind || (src === 'fx' ? 'fx' : src === 'research' ? 'research' : guess || 'coin-update'),
    source: src,
    title,
    body: lines.slice(i + 1).join('\n').replace(/^\n+/, ''),
    url: url || (token ? `/coins/${token.toLowerCase()}` : src === 'fx' ? '/fx' : null),
  };
}

// Post to the hub, signed with the bot token (the Worker has the same token). Returns { telegram } or null.
export async function toHub(event) {
  const { HUB_URL: hub, TELEGRAM_BOT_TOKEN: tok } = process.env;
  if (!hub || !tok) return null;
  const raw = JSON.stringify({ ts: Date.now(), event });
  const sig = crypto.createHmac('sha256', tok).update(raw).digest('hex');
  try {
    const r = await globalThis.fetch(`${hub.trim().replace(/\/+$/, '')}/api/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature': `sha256=${sig}` },
      body: raw,
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      console.error('hub: HTTP', r.status); // never log the URL
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error('hub: unreachable', e.name);
    return null;
  }
}

// buttons: [[{ text, data }]] → Telegram inline keyboard (handled by the Telegram bot Worker)
// opts: { kind, url, source } for the Hood Desk inbox (guessed from the text when left out)
export async function notify(text, { buttons = null, ...opts } = {}) {
  const sends = [];
  const dry = process.env.DRY_RUN === '1';
  const { TELEGRAM_BOT_TOKEN: tg, TELEGRAM_CHAT_ID: chat, DISCORD_WEBHOOK_URL: discord } = process.env;

  if (dry || (!(tg && chat) && !discord)) {
    const btn = buttons ? '\n[buttons] ' + buttons.flat().map((b) => `${b.text} → ${b.data}`).join(' | ') : '';
    console.log('\n──── ALERT ────\n' + text + btn + '\n───────────────');
    return;
  }
  // Hood Desk first; it says whether Telegram is still on (hub down → Telegram as before)
  const hub = await toHub(eventFor(text, buttons, opts));
  if (tg && chat && hub?.telegram !== false) {
    sends.push(
      globalThis.fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat,
          text: text.slice(0, 4000),
          disable_web_page_preview: true,
          ...(buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
        }),
      })
    );
  }
  if (discord) {
    sends.push(
      globalThis.fetch(discord, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text.slice(0, 1900) }),
      })
    );
  }
  const results = await Promise.allSettled(sends);
  for (const r of results) {
    if (r.status === 'rejected') console.error('notify failed:', r.reason?.message);
    else if (!r.value.ok) console.error('notify failed: HTTP', r.value.status);
  }
}
