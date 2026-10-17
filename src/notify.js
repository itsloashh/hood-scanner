// Alerts to your phone. Telegram and/or Discord — both free.
// With neither configured (or DRY_RUN=1) messages just print to the log.

export async function notify(text) {
  const sends = [];
  const dry = process.env.DRY_RUN === '1';
  const { TELEGRAM_BOT_TOKEN: tg, TELEGRAM_CHAT_ID: chat, DISCORD_WEBHOOK_URL: discord } = process.env;

  if (dry || (!(tg && chat) && !discord)) {
    console.log('\n──── ALERT ────\n' + text + '\n───────────────');
    return;
  }
  if (tg && chat) {
    sends.push(
      globalThis.fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }),
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
