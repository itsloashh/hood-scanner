// FX data sources — all free and keyless. Every fetch has a timeout and reports health,
// so a dead source is visible (data/fx/health.json) instead of silently missing.
import { FX } from './config.js';

export const health = {}; // source → { ok, error, at }
const mark = (name, ok, error = null) => {
  health[name] = { ok, error: error ? String(error).slice(0, 160) : null, at: new Date().toISOString() };
};

const UA = 'Mozilla/5.0 (compatible; hood-scanner-fx/1.0; +github.com/itsloashh/hood-scanner)';

export async function fetchText(url, { timeoutMs = 20_000, name = null } = {}) {
  try {
    const res = await globalThis.fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (name) mark(name, true);
    return text;
  } catch (e) {
    if (name) mark(name, false, e.message);
    throw e;
  }
}

// ── prices (Yahoo Finance chart API) ───────────────────────
// → [{ t, o, h, l, c, v }] oldest → newest
export function parseYahoo(json) {
  const r = json?.chart?.result?.[0];
  if (!r?.timestamp) return [];
  const q = r.indicators?.quote?.[0] || {};
  return r.timestamp
    .map((t, i) => ({ t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] ?? 0 }))
    .filter((k) => [k.o, k.h, k.l, k.c].every((x) => typeof x === 'number' && Number.isFinite(x)));
}

export async function candles(symbol, { range = '6mo', interval = '1d' } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const text = await fetchText(url, { name: `yahoo:${symbol}:${interval}` });
  return parseYahoo(JSON.parse(text));
}

// ── economic calendar (ForexFactory weekly JSON) ───────────
export function parseCalendar(list) {
  return (Array.isArray(list) ? list : [])
    .map((e) => ({
      title: e.title, country: e.country, impact: e.impact, at: Date.parse(e.date),
      forecast: e.forecast || null, previous: e.previous || null, actual: e.actual || null,
    }))
    .filter((e) => Number.isFinite(e.at) && FX.calendar.currencies.includes(e.country))
    .sort((a, b) => a.at - b.at);
}

export async function calendar() {
  return parseCalendar(JSON.parse(await fetchText(FX.calendar.url, { name: 'forexfactory calendar' })));
}

// ── news (RSS) ─────────────────────────────────────────────
const decode = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

export function parseRss(xml, source) {
  const items = [];
  const blocks = String(xml).match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const tag = (name) => b.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1];
    const title = decode(tag('title'));
    let link = decode(tag('link'));
    if (!link) link = b.match(/<link[^>]*href="([^"]+)"/i)?.[1] || '';
    const when = Date.parse(decode(tag('pubDate') || tag('published') || tag('updated') || tag('dc:date')));
    // Google News appends " - Publisher" to titles; keep it as the source
    const srcTag = decode(tag('source'));
    if (title) items.push({ title, link, at: Number.isFinite(when) ? when : null, source: srcTag || source });
  }
  return items;
}

export async function feed(name, url) {
  return parseRss(await fetchText(url, { name: `rss:${name}` }), name);
}

// ── Google News links → the publisher's own article URL ─────
// Google News RSS links (news.google.com/rss/articles/<id>) only reach the article through Google's scripts,
// which often leaves a blank page on phones. Google's own "garturlreq" lookup returns the real address.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
export const googleNewsId = (link) => String(link || '').match(/^https:\/\/news\.google\.com\/(?:rss\/)?articles\/([A-Za-z0-9_-]+)/)?.[1] || null;

export function parseBatchExecute(text) {
  for (const part of String(text).split('\n\n').slice(1)) {
    try {
      const arr = JSON.parse(part);
      const inner = JSON.parse(arr[0][2]);
      if (/^https?:\/\//.test(inner?.[1] || '')) return inner[1];
    } catch {
      // try the next chunk
    }
  }
  return null;
}

export async function resolveGoogleNews(link, { timeoutMs = 12_000 } = {}) {
  const id = googleNewsId(link);
  if (!id) return link;
  const page = await globalThis.fetch(`https://news.google.com/articles/${id}?hl=en-US&gl=US&ceid=US:en`, { headers: { 'user-agent': BROWSER_UA, 'accept-language': 'en-US' }, signal: AbortSignal.timeout(timeoutMs) });
  const html = await page.text();
  const sig = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sig || !ts) return null;
  const req = [[['Fbv4je', JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sig]), null, 'generic']]];
  const r = await globalThis.fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': BROWSER_UA },
    body: `f.req=${encodeURIComponent(JSON.stringify(req))}`,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return r.ok ? parseBatchExecute(await r.text()) : null;
}

// ── positioning (CFTC Commitments of Traders, weekly) ─────
export function parseCot(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => {
      const long = Number(r.noncomm_positions_long_all);
      const short = Number(r.noncomm_positions_short_all);
      return { date: String(r.report_date_as_yyyy_mm_dd || '').slice(0, 10), long, short, net: long - short, oi: Number(r.open_interest_all) || null };
    })
    .filter((r) => r.date && Number.isFinite(r.net))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
}

export async function cot(market) {
  // the CFTC site is slow — give it longer, and one retry
  const get = () => fetchText(FX.cotUrl(market), { name: `cot:${market.split(' - ')[0]}`, timeoutMs: 45_000 });
  return parseCot(JSON.parse(await get().catch(get)));
}

// ── US rates (FRED, keyless CSV) → [{ t, v }] oldest → newest, missing days skipped
export function parseFredCsv(text) {
  return String(text)
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [d, v] = line.split(',');
      return { t: Date.parse(d), v: Number(v) };
    })
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v));
}

export async function fred(id) {
  return parseFredCsv(await fetchText(FX.fredUrl(id), { name: `fred:${id}` }));
}

// ── live spot quotes (keyless): Swissquote's public feed, gold-api.com as backup for gold
// → { price, source }. Used to put gold on spot and to cross-check CAD/JPY.
export function parseSwissquote(json) {
  const mids = [];
  for (const venue of Array.isArray(json) ? json : []) {
    for (const p of venue.spreadProfilePrices || []) {
      if (p.bid > 0 && p.ask > 0) mids.push((p.bid + p.ask) / 2);
    }
  }
  if (!mids.length) return null;
  mids.sort((a, b) => a - b);
  return mids[Math.floor(mids.length / 2)];
}

export async function spotQuote(base, quote) {
  try {
    const j = JSON.parse(await fetchText(`https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${base}/${quote}`, { name: `swissquote:${base}${quote}` }));
    const price = parseSwissquote(j);
    if (price) return { price, source: 'Swissquote' };
  } catch {
    /* try the backup */
  }
  if (base === 'XAU') {
    const j = JSON.parse(await fetchText('https://api.gold-api.com/price/XAU', { name: 'gold-api:XAU' }));
    if (Number(j?.price) > 0) return { price: Number(j.price), source: 'gold-api.com' };
  }
  return null;
}
