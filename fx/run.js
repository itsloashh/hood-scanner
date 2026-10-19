// FX DESK runner. Modes (env FX_MODE):
//   watch  — every 15 min: event heads-ups, level breaks, fast moves, driver shocks, breaking headlines
//   brief  — weekday morning brief      weekly — Sunday outlook (calendar for the week + positioning)
//   probe  — fetch everything, write data/fx/health.json + latest.json, send nothing
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FX } from './config.js';
import * as src from './sources.js';
import { bias, driverMove, macroMove, pct, cadjpyCot } from './analysis.js';
import * as msg from './messages.js';
import { notify } from '../src/notify.js';
import { DATA_DIR } from '../src/store.js';

const HOUR = 3_600_000;
// on every FX message: jump into the Telegram FX menu
const FX_BUTTONS = [[{ text: '🌍 FX menu', data: 'fx' }, { text: '🥇 Gold', data: 'fxp:XAUUSD' }, { text: '🇨🇦🇯🇵 CAD/JPY', data: 'fxp:CADJPY' }], [{ text: '📅 Calendar', data: 'fxc:today' }, { text: '📰 Headlines', data: 'fxn:all' }]];
const log = (...a) => console.log(new Date().toISOString(), ...a);
const FX_DIR = () => path.join(DATA_DIR, 'fx');
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

// FX trades Sun 17:00 → Fri 17:00 New York time
export function marketOpen(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  if (p.weekday === 'Sat') return false;
  if (p.weekday === 'Sun') return h >= 17;
  if (p.weekday === 'Fri') return h < 17;
  return true;
}

const hash = (s) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return String(h >>> 0);
};

// Prices for a pair. CAD/JPY: Yahoo spot candles. Gold: futures candles shifted onto the live
// spot quote (Swissquote / gold-api.com) so levels line up with TradingView OANDA:XAUUSD.
// The live quote also cross-checks the price; disagreement is noted in the brief.
async function pairCandles(key, P, snap) {
  const get = async (sym) => ({
    daily: await src.candles(sym, { range: '1y', interval: '1d' }).catch(() => []),
    hourly: await src.candles(sym, { range: '10d', interval: '1h' }).catch(() => []),
  });
  const quote = P.spot ? await src.spotQuote(...P.spot).catch(() => null) : null;
  let daily = [];
  let hourly = [];
  let source = '';
  if (P.yahoo) {
    ({ daily, hourly } = await get(P.yahoo));
    source = `${P.yahoo} (spot)`;
  }
  if ((!daily.length || !hourly.length) && P.futures) {
    const fut = await get(P.futures);
    if (fut.daily.length) {
      const lastFut = (fut.hourly.at(-1) || fut.daily.at(-1)).c;
      const basis = quote ? quote.price - lastFut : 0;
      const shift = (k) => ({ ...k, o: k.o + basis, h: k.h + basis, l: k.l + basis, c: k.c + basis });
      daily = fut.daily.map(shift);
      hourly = fut.hourly.map(shift);
      source = quote ? `spot (${quote.source}), chart from futures shifted ${basis >= 0 ? '+' : '−'}${Math.abs(basis).toFixed(1)}` : `${P.futures} futures — spot unavailable, may differ from your chart by a few dollars`;
      if (!quote) snap.priceNotes.push(`${P.name}: live spot quote unavailable — prices are COMEX futures (a few dollars off spot)`);
    }
  }
  const price = (hourly.at(-1) || daily.at(-1))?.c;
  if (quote && price && P.yahoo) {
    const diff = Math.abs(price / quote.price - 1) * 100;
    if (diff > FX.priceCheckMaxDiffPct) snap.priceNotes.push(`${P.name}: sources disagree by ${diff.toFixed(2)}% (${price.toFixed(P.decimals)} vs ${quote.price.toFixed(P.decimals)} on ${quote.source}) — double-check your chart`);
  }
  return { daily, hourly, source };
}

// Pull every source; anything that fails is recorded in health and left out
export async function snapshot(now = Date.now(), { withCot = true, withNews = true } = {}) {
  const snap = { at: now, pairs: {}, drivers: {}, macro: {}, events: [], headlines: [], cot: null, health: src.health, priceNotes: [] };
  for (const [key, M] of Object.entries(FX.macro)) {
    try {
      snap.macro[key] = macroMove(await src.fred(M.fred));
    } catch (e) {
      log(`macro ${key} failed: ${e.message}`);
    }
  }
  for (const [key, D] of Object.entries(FX.drivers)) {
    try {
      snap.drivers[key] = driverMove(await src.candles(D.yahoo, { range: '1mo', interval: '1d' }));
    } catch (e) {
      log(`driver ${key} failed: ${e.message}`);
    }
  }
  let cot = {};
  if (withCot) {
    try {
      cot.XAUUSD = await src.cot(FX.pairs.XAUUSD.cot);
    } catch (e) {
      log('COT gold failed:', e.message);
    }
    try {
      const [cad, jpy] = await Promise.all(FX.pairs.CADJPY.cot.map((m) => src.cot(m)));
      cot.CADJPY = cadjpyCot(cad, jpy);
    } catch (e) {
      log('COT CAD/JPY failed:', e.message);
    }
    snap.cot = cot;
  }
  for (const [key, P] of Object.entries(FX.pairs)) {
    try {
      const { daily, hourly, source } = await pairCandles(key, P, snap);
      if (!daily.length) throw new Error('no daily candles');
      const b = bias(key, { daily, hourly, drivers: snap.drivers, macro: snap.macro, cot: cot[key] });
      b.source = source;
      const prevClose = daily.length >= 2 ? daily[daily.length - 2].c : null;
      snap.pairs[key] = { bias: b, dayChange: pct(b.price, prevClose), hourly: hourly.slice(-48) };
    } catch (e) {
      log(`pair ${key} failed: ${e.message}`);
    }
  }
  try {
    snap.events = await src.calendar();
    snap.calendarOk = true;
  } catch (e) {
    snap.calendarOk = false;
    log('calendar failed:', e.message);
  }
  if (withNews) snap.headlines = await headlines(now);
  return snap;
}

// Headlines from several sites, matched to the pair they affect, newest first, deduped by title
export async function headlines(now = Date.now()) {
  const all = [];
  const jobs = [
    ...FX.feeds.map((f) => ({ name: f.name, url: f.url, always: f.always })),
    ...Object.entries(FX.pairs).flatMap(([key, P]) => P.news.map((q) => ({ name: `google:${q}`, url: FX.googleNews(q), pair: key }))),
  ];
  for (const j of jobs) {
    try {
      for (const it of await src.feed(j.name, j.url)) all.push({ ...it, pair: j.pair || null, official: Boolean(j.always) });
    } catch (e) {
      log(`feed ${j.name} failed: ${e.message}`);
    }
  }
  const kept = []; // [{ words, story }] — the same story from another outlet adds to that story's outlet count
  const out = [];
  const words = (t) => new Set(t.toLowerCase().replace(/ - [^-]+$/, '').replace(/[^a-z0-9% ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['the', 'and', 'for', 'says', 'with', 'from', 'reuters', 'after'].includes(w)));
  const sameStory = (a, b) => {
    let n = 0;
    for (const w of a) if (b.has(w)) n += 1;
    return n / Math.min(a.size, b.size) >= 0.6;
  };
  for (const h of all.filter((x) => !x.at || now - x.at < 36 * HOUR).sort((a, b) => (b.at || 0) - (a.at || 0))) {
    if (/^(opinion|analysis|editorial|letters?)\b[:\s]/i.test(h.title)) continue;
    const w = words(h.title);
    if (!w.size) continue;
    const trusted = h.official || FX.trustedSources.test(h.source || '');
    const dup = kept.find((k) => sameStory(w, k.words));
    if (dup) {
      if (trusted && dup.story) dup.story.outlets.add(h.source || '?');
      continue;
    }
    h.pairs = pairsFor(h);
    h.title = h.title.replace(/ - [^-]{2,60}$/, ''); // Google appends " - Publisher"
    h.outlets = new Set(trusted ? [h.source || '?'] : []);
    const keep = trusted && (h.pairs.length || h.official);
    kept.push({ words: w, story: keep ? h : null });
    if (keep) out.push(h);
  }
  for (const h of out) {
    h.confirmed = h.outlets.size;
    h.outlets = [...h.outlets];
  }
  return out;
}

const PAIR_WORDS = {
  XAUUSD: /\bgold\b|xau|bullion|precious metal|\bfed\b|federal reserve|powell|warsh|fomc|treasury yield|dollar index|\bdxy\b|us cpi|us inflation|u\.s\. inflation|payrolls|nfp/i,
  CADJPY: /canad|loonie|\bcad\b|bank of canada|\bboc\b|macklem|\byen\b|\bjpy\b|bank of japan|\bboj\b|ueda|japan|crude|\boil\b|opec/i,
};
export const pairsFor = (h) => Object.entries(PAIR_WORDS).filter(([, re]) => re.test(h.title)).map(([k]) => FX.pairs[k].name);

// ── watch mode: what changed since the last run? ─────────────
export function watchAlerts(snap, state, now = Date.now()) {
  const out = [];
  const once = (key, cooldownH, text) => {
    const prev = state.alerted[key];
    if (prev && now - prev < cooldownH * HOUR) return;
    state.alerted[key] = now;
    out.push(text);
  };
  // 1. high-impact releases coming up / just released
  for (const e of snap.events || []) {
    const mins = Math.round((e.at - now) / 60000);
    const speech = FX.calendar.speeches.test(e.title) && (e.impact === 'High' || e.impact === 'Medium');
    if ((FX.calendar.alertImpact.includes(e.impact) || speech) && mins > 0 && mins <= FX.calendar.warnMinutes) {
      once(`ev:${e.country}:${e.title}:${e.at}`, 48, msg.eventSoonMessage(e, mins));
    }
    if (e.actual && e.at <= now && now - e.at < 2 * HOUR && (e.impact === 'High' || FX.calendar.goldKeywords.test(e.title))) {
      once(`res:${e.country}:${e.title}:${e.at}`, 48, msg.eventResultMessage(e));
    }
  }
  // 2. level breaks + 3. fast moves
  for (const [key, s] of Object.entries(snap.pairs)) {
    const b = s.bias;
    const lv = b.levels;
    const price = b.price;
    const prev = state.lastPrice[key];
    if (lv && prev != null) {
      const checks = [['previous day high', lv.prevDayHigh, 'up'], ['previous day low', lv.prevDayLow, 'down'], ['previous week high', lv.prevWeekHigh, 'up'], ['previous week low', lv.prevWeekLow, 'down']];
      if (b.daily?.lastHigh) checks.push(['last daily swing high', b.daily.lastHigh, 'up']);
      if (b.daily?.lastLow) checks.push(['last daily swing low', b.daily.lastLow, 'down']);
      for (const [name, level, dir] of checks) {
        if (level == null) continue;
        const crossed = dir === 'up' ? prev <= level && price > level : prev >= level && price < level;
        if (crossed) once(`lvl:${key}:${name}:${level.toFixed(4)}`, FX.structure.levelCooldownHours, msg.levelBreakMessage(key, name, level, dir, price));
      }
    }
    state.lastPrice[key] = price;
    const h = s.hourly || [];
    if (lv?.atr && h.length >= 5) {
      const from = h[h.length - 5].c;
      const move = price - from;
      const share = Math.abs(move) / lv.atr;
      if (share >= FX.structure.bigMoveAtr * 0.6) once(`fast:${key}:${Math.sign(move)}`, 4, msg.fastMoveMessage(key, pct(price, from), share, 4, price));
    }
  }
  // 4. driver shocks (once per driver per day and direction)
  const day = new Date(now).toISOString().slice(0, 10);
  for (const [key, m] of Object.entries(snap.drivers)) {
    if (m?.d1 != null && Math.abs(m.d1) >= FX.drivers[key].shockPct) once(`drv:${key}:${day}:${Math.sign(m.d1)}`, 20, msg.driverShockMessage(key, m));
  }
  // 4b. yen intervention watch: official warning language in trusted news
  const warn = state.primed ? (snap.headlines || []).find((h) => FX.intervention.words.test(h.title) && /yen|jpy|japan/i.test(h.title) && (!h.at || now - h.at < 6 * HOUR)) : null;
  if (warn) {
    once(`intv:${day}`, 20, msg.interventionMessage(warn));
  }

  // 5. breaking headlines (new ones only)
  let sent = 0;
  for (const h of snap.headlines || []) {
    const k = `news:${hash(h.title.toLowerCase())}`;
    if (state.alerted[k]) continue;
    const fresh = !h.at || now - h.at < 3 * HOUR;
    const important = (FX.breaking.test(h.title) && (h.confirmed >= FX.confirmOutlets || h.official)) || (h.official && fresh);
    if (!state.primed) {
      state.alerted[k] = now; // first run: remember what's already out there, don't flood
      continue;
    }
    state.alerted[k] = now;
    if (fresh && important && (h.pairs.length || h.official) && sent < FX.maxHeadlineAlertsPerRun) {
      out.push(msg.headlineMessage(h, h.pairs.length ? h.pairs : ['Central bank']));
      sent += 1;
    }
  }
  state.primed = true;
  // forget old keys
  for (const [k, t] of Object.entries(state.alerted)) if (now - t > 4 * 86_400_000) delete state.alerted[k];
  return out;
}

// ── release results: shortly after a high-impact release, find the published number in the news ──
// how newsrooms word the same release
const SYN = [
  [/cpi|consumer price/i, ['inflation', 'consumer price']],
  [/non-farm|nfp|employment change/i, ['payroll', 'jobs', 'hiring', 'employment']],
  [/unemployment/i, ['jobless', 'unemployment']],
  [/gdp/i, ['economy', 'growth', 'gdp']],
  [/retail sales/i, ['retail', 'consumer spending']],
  [/pce/i, ['pce', 'inflation']],
  [/ppi/i, ['producer price', 'wholesale']],
  [/rate statement|policy rate|rate decision|monetary policy/i, ['rate', 'rates']],
];
const synonyms = (t) => SYN.filter(([re]) => re.test(t)).flatMap(([, w]) => w);
const cleanTitle = (t) => t.replace(/\b(m\/m|y\/y|q\/q|3m\/3m)\b/gi, '').replace(/\s+/g, ' ').trim();
export async function releaseResults(snap, state, now = Date.now()) {
  const out = [];
  const [minA, minB] = FX.calendar.resultSearchMinutes;
  for (const e of snap.events || []) {
    const mins = (now - e.at) / 60000;
    const matters = e.impact === 'High' || (e.country === 'USD' && FX.calendar.goldKeywords.test(e.title));
    if (!matters || mins < minA || mins > minB || FX.calendar.speeches.test(e.title)) continue;
    const key = `res:${e.country}:${e.title}:${e.at}`;
    if (state.alerted[key]) continue;
    if (e.actual) {
      state.alerted[key] = now;
      out.push(msg.eventResultMessage(e));
      continue;
    }
    const q = `${FX.calendar.countryName[e.country] || e.country} ${cleanTitle(e.title)}`;
    let items = [];
    try {
      items = await src.feed(`result:${q}`, FX.googleNews(q).replace('when:1d', 'when:2h'));
    } catch {
      continue;
    }
    const words = [...cleanTitle(e.title).toLowerCase().split(/\s+/).filter((w) => w.length > 2), ...synonyms(e.title)];
    const hit = items
      .filter((h) => FX.trustedSources.test(h.source || '') && (!h.at || h.at >= e.at - 10 * 60000))
      .find((h) => words.some((w) => h.title.toLowerCase().includes(w)) && /\d/.test(h.title));
    if (hit) {
      state.alerted[key] = now;
      out.push(msg.eventNewsResultMessage(e, hit));
    }
  }
  return out;
}

// ── accuracy: was each lean right? (next session close and ~1 week later) ──
export function trackLeans(log, snap, now = Date.now(), { record = false } = {}) {
  const DAYMS = 86_400_000;
  for (const x of log) {
    const p = snap.pairs[x.pair]?.bias?.price;
    if (!p) continue;
    if (x.dayRight == null && now - x.at >= 20 * 3_600_000) x.dayRight = rightWay(x, p);
    if (x.weekRight == null && now - x.at >= 6.5 * DAYMS) x.weekRight = rightWay(x, p);
  }
  if (record) {
    for (const [pair, s] of Object.entries(snap.pairs)) {
      const b = s.bias;
      const today = new Date(now).toISOString().slice(0, 10);
      if (log.some((x) => x.pair === pair && x.day === today)) continue;
      log.push({ at: now, day: today, pair, lean: b.label, score: b.score, price: b.price, dayRight: null, weekRight: null });
    }
  }
  while (log.length > 500) log.shift();
  return log;
}
// mixed leans aren't calls; a bullish lean is right if price is higher, bearish if lower
const rightWay = (x, p) => (x.lean.startsWith('Bullish') ? p > x.price : x.lean.startsWith('Bearish') ? p < x.price : null);

export function trackRecord(log) {
  const out = {};
  for (const x of log) {
    const r = (out[x.pair] ||= { dayRight: 0, dayN: 0, weekRight: 0, weekN: 0 });
    if (x.dayRight != null) {
      r.dayN += 1;
      if (x.dayRight) r.dayRight += 1;
    }
    if (x.weekRight != null) {
      r.weekN += 1;
      if (x.weekRight) r.weekRight += 1;
    }
  }
  return out;
}

// Compact snapshot for the Telegram /fx and /fxcal commands
export function latestFor(snap) {
  return {
    at: new Date(snap.at).toISOString(),
    pairs: Object.fromEntries(Object.entries(snap.pairs).map(([k, s]) => [k, {
      name: FX.pairs[k].name, price: s.bias.price, dayChange: s.dayChange, lean: s.bias.label, score: s.bias.score, max: s.bias.max,
      reasons: s.bias.factors.map((f) => `${f.dir > 0 ? '▲' : '▼'} ${f.why}`), levels: s.bias.levels, decimals: FX.pairs[k].decimals,
      daily: s.bias.daily?.describe, hourly: s.bias.hourly?.describe, source: s.bias.source || null,
    }])),
    drivers: Object.fromEntries(Object.entries(snap.drivers).filter(([, m]) => m).map(([k, m]) => [k, { name: FX.drivers[k].name, ...m }])),
    macro: Object.fromEntries(Object.entries(snap.macro || {}).filter(([, m]) => m).map(([k, m]) => [k, { name: FX.macro[k].name, ...m }])),
    record: snap.record || null,
    priceNotes: snap.priceNotes || [],
    events: (snap.events || []).filter((e) => e.impact === 'High' || e.impact === 'Medium').map((e) => ({ ...e })),
    headlines: (snap.headlines || []).slice(0, 10).map((h) => ({ title: h.title, source: h.source, at: h.at, pairs: h.pairs })),
  };
}

export async function main(mode = process.env.FX_MODE || 'watch', now = Date.now()) {
  fs.mkdirSync(FX_DIR(), { recursive: true });
  const stateFile = path.join(FX_DIR(), 'state.json');
  const state = readJson(stateFile, {});
  state.alerted ||= {};
  state.lastPrice ||= {};
  if (mode === 'watch' && !marketOpen(now)) {
    log('FX market closed — nothing to watch');
    return { mode, skipped: 'closed' };
  }
  const snap = await snapshot(now, { withCot: mode !== 'watch', withNews: true });
  const leanFile = path.join(FX_DIR(), 'leans.json');
  const leans = trackLeans(readJson(leanFile, []), snap, now, { record: mode === 'brief' || mode === 'weekly' });
  snap.record = trackRecord(leans);
  let sent = 0;
  if (mode === 'brief' || mode === 'weekly') {
    await notify(msg.briefMessage(snap, { weekly: mode === 'weekly' }), { buttons: FX_BUTTONS });
    sent = 1;
    // seed price memory + headline memory so the next watch run only reports changes
    for (const [k, s] of Object.entries(snap.pairs)) state.lastPrice[k] = s.bias.price;
  } else if (mode === 'watch') {
    for (const text of [...watchAlerts(snap, state, now), ...(await releaseResults(snap, state, now))]) {
      await notify(text, { buttons: FX_BUTTONS });
      sent += 1;
    }
  }
  fs.writeFileSync(path.join(FX_DIR(), 'latest.json'), JSON.stringify(latestFor(snap)));
  fs.writeFileSync(path.join(FX_DIR(), 'health.json'), JSON.stringify({ at: new Date(now).toISOString(), mode, sources: src.health }, null, 1));
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(leanFile, JSON.stringify(leans));
  const bad = Object.entries(src.health).filter(([, v]) => !v.ok).length;
  log(`FX ${mode}: ${Object.keys(snap.pairs).length} pairs, ${snap.events.length} events, ${snap.headlines.length} headlines, ${sent} message(s), ${bad} source(s) down`);
  return { mode, sent, pairs: Object.keys(snap.pairs).length, events: snap.events.length, headlines: snap.headlines.length, down: bad };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(async (e) => {
    console.error(e);
    process.exit(1);
  });
}
