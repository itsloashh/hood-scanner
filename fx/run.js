// FX DESK runner. Modes (env FX_MODE):
//   watch  — every 15 min: event heads-ups, level breaks, fast moves, driver shocks, breaking headlines
//   brief  — weekday morning brief      weekly — Sunday outlook (calendar for the week + positioning)
//   probe  — fetch everything, write data/fx/health.json + latest.json, send nothing
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FX } from './config.js';
import * as src from './sources.js';
import { bias, driverMove, pct, cadjpyCot } from './analysis.js';
import * as msg from './messages.js';
import { notify } from '../src/notify.js';
import { DATA_DIR } from '../src/store.js';

const HOUR = 3_600_000;
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

// Pull every source; anything that fails is recorded in health and left out
export async function snapshot(now = Date.now(), { withCot = true, withNews = true } = {}) {
  const snap = { at: now, pairs: {}, drivers: {}, events: [], headlines: [], cot: null, health: src.health };
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
      const daily = await src.candles(P.yahoo, { range: '1y', interval: '1d' });
      const hourly = await src.candles(P.yahoo, { range: '10d', interval: '1h' });
      if (!daily.length) throw new Error('no daily candles');
      const b = bias(key, { daily, hourly, drivers: snap.drivers, cot: cot[key] });
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
  const seen = new Set();
  const out = [];
  for (const h of all.filter((x) => !x.at || now - x.at < 36 * HOUR).sort((a, b) => (b.at || 0) - (a.at || 0))) {
    const k = h.title.toLowerCase().replace(/ - [^-]+$/, '').slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k);
    h.pairs = pairsFor(h);
    if (h.pairs.length || h.official) out.push(h);
  }
  return out;
}

const PAIR_WORDS = {
  XAUUSD: /\bgold\b|xau|bullion|precious metal|\bfed\b|federal reserve|powell|fomc|treasury yield|dollar index|\bdxy\b|us cpi|inflation|payrolls|nfp/i,
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
    if (FX.calendar.alertImpact.includes(e.impact) && mins > 0 && mins <= FX.calendar.warnMinutes) {
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
  // 5. breaking headlines (new ones only)
  let sent = 0;
  for (const h of snap.headlines || []) {
    const k = `news:${hash(h.title.toLowerCase())}`;
    if (state.alerted[k]) continue;
    const fresh = !h.at || now - h.at < 3 * HOUR;
    const important = FX.breaking.test(h.title) || (h.official && fresh);
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

// Compact snapshot for the Telegram /fx and /fxcal commands
export function latestFor(snap) {
  return {
    at: new Date(snap.at).toISOString(),
    pairs: Object.fromEntries(Object.entries(snap.pairs).map(([k, s]) => [k, {
      name: FX.pairs[k].name, price: s.bias.price, dayChange: s.dayChange, lean: s.bias.label, score: s.bias.score, max: s.bias.max,
      reasons: s.bias.factors.map((f) => `${f.dir > 0 ? '▲' : '▼'} ${f.why}`), levels: s.bias.levels, decimals: FX.pairs[k].decimals,
      daily: s.bias.daily?.describe, hourly: s.bias.hourly?.describe,
    }])),
    drivers: Object.fromEntries(Object.entries(snap.drivers).filter(([, m]) => m).map(([k, m]) => [k, { name: FX.drivers[k].name, ...m }])),
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
  let sent = 0;
  if (mode === 'brief' || mode === 'weekly') {
    await notify(msg.briefMessage(snap, { weekly: mode === 'weekly' }));
    sent = 1;
    // seed price memory + headline memory so the next watch run only reports changes
    for (const [k, s] of Object.entries(snap.pairs)) state.lastPrice[k] = s.bias.price;
  } else if (mode === 'watch') {
    for (const text of watchAlerts(snap, state, now)) {
      await notify(text);
      sent += 1;
    }
  }
  fs.writeFileSync(path.join(FX_DIR(), 'latest.json'), JSON.stringify(latestFor(snap)));
  fs.writeFileSync(path.join(FX_DIR(), 'health.json'), JSON.stringify({ at: new Date(now).toISOString(), mode, sources: src.health }, null, 1));
  fs.writeFileSync(stateFile, JSON.stringify(state));
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
