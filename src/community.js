// Free community signals. X's API is paid-only, so instead we measure:
//   • Telegram group/channel size (free via your own bot's API)
//   • X handle reuse — the same @handle linked to more than one token is a
//     classic copycat / recycled-scam sign
//   • GeckoTerminal sentiment votes + suspicious reports, and GT trust score

import { CONFIG } from '../config.js';

const HOUR = 3_600_000;

export function cleanHandle(h) {
  if (!h) return null;
  const s = String(h)
    .trim()
    .replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me|x\.com|twitter\.com)\//i, '')
    .replace(/^@/, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
  return /^[a-z0-9_]{3,40}$/.test(s) ? s : null;
}

// Telegram member count for a public group/channel. Cached 12h per handle.
export async function telegramMembers(handle, cache, now = Date.now()) {
  const h = cleanHandle(handle);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!h || !token) return null;
  const hit = cache[h];
  if (hit && now - hit.at < 12 * HOUR) return hit.n;
  let n = null;
  try {
    const res = await globalThis.fetch(
      `https://api.telegram.org/bot${token}/getChatMemberCount?chat_id=@${encodeURIComponent(h)}`
    );
    const j = await res.json();
    if (j?.ok && Number.isFinite(j.result)) n = j.result;
  } catch {
    /* private group, typo, or Telegram hiccup — treat as unknown */
  }
  cache[h] = { at: now, n };
  return n;
}

// Track which tokens each X handle has been linked to.
export function recordXHandle(xIndex, handle, token) {
  const h = cleanHandle(handle);
  if (!h) return 0;
  xIndex[h] ||= [];
  if (!xIndex[h].includes(token)) xIndex[h].push(token);
  if (xIndex[h].length > 10) xIndex[h] = xIndex[h].slice(-10);
  return xIndex[h].filter((t) => t !== token).length; // other tokens using it
}

// Pulls everything together for one coin.
export async function communitySignals({ pool, info, state, now = Date.now() }) {
  const tgHandle = info?.telegram || null;
  const tgMembers = await telegramMembers(tgHandle, state.tgCache, now);
  const xShared = info?.twitter ? recordXHandle(state.xIndex, info.twitter, pool.baseToken.address) : 0;
  const votes = pool.sentimentPos != null || pool.sentimentNeg != null;
  return {
    x: cleanHandle(info?.twitter),
    xShared,
    tg: cleanHandle(tgHandle),
    tgMembers,
    sentimentPos: votes ? pool.sentimentPos : null,
    susReports: pool.susReports || 0,
    gtScore: info?.gtScore ?? null,
    flags: [
      xShared >= CONFIG.community.maxSharedXHandle ? `X @${cleanHandle(info.twitter)} also linked to ${xShared} other token(s) — possible copycat` : null,
      pool.susReports > 0 ? `${pool.susReports} GeckoTerminal "suspicious" report(s)` : null,
    ].filter(Boolean),
  };
}
