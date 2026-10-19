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
  return parseCot(JSON.parse(await fetchText(FX.cotUrl(market), { name: `cot:${market.split(' - ')[0]}` })));
}
