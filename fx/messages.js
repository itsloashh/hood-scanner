// FX Telegram messages — context in plain English, never "buy/sell".
import { FX } from './config.js';
import { fmt } from './analysis.js';

const TZ = FX.timezone;
export const local = (ms, opts = {}) => new Date(ms).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit', ...opts });
const sgn = (v, d = 2) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}%`);
const arrow = (v) => (v == null ? '·' : v > 0 ? '▲' : v < 0 ? '▼' : '·');
const flag = { USD: '🇺🇸', CAD: '🇨🇦', JPY: '🇯🇵' };
const leanIcon = (b) => (b.label.startsWith('Bullish') ? '🟢' : b.label.startsWith('Bearish') ? '🔴' : '⚪');

function pairBlock(key, s) {
  const P = FX.pairs[key];
  const b = s.bias;
  const L = [];
  L.push(`${leanIcon(b)} ${P.name} — ${fmt(key, b.price)} (${sgn(s.dayChange)} today)`);
  L.push(`Lean: ${b.label} (${b.score > 0 ? '+' : ''}${b.score} of ±${b.max})`);
  const top = [...b.factors].sort((x, y) => y.weight - x.weight);
  for (const x of top.slice(0, 7)) L.push(`  ${x.dir > 0 ? '▲' : '▼'} ${x.why}`);
  const lv = b.levels;
  if (lv) {
    L.push(`Levels: prev day ${fmt(key, lv.prevDayLow)}–${fmt(key, lv.prevDayHigh)}${lv.prevWeekHigh ? ` · prev week ${fmt(key, lv.prevWeekLow)}–${fmt(key, lv.prevWeekHigh)}` : ''}`);
    if (lv.atr) L.push(`Typical daily range (ATR): ${fmt(key, lv.atr)}`);
  }
  return L;
}

function eventLine(e) {
  const nums = [e.actual ? `actual ${e.actual}` : null, e.forecast ? `fcst ${e.forecast}` : null, e.previous ? `prev ${e.previous}` : null].filter(Boolean).join(' · ');
  return `${e.impact === 'High' ? '🔴' : '🟠'} ${local(e.at)} ${flag[e.country] || e.country} ${e.title}${nums ? ` (${nums})` : ''}`;
}

export function briefMessage(snap, { weekly = false } = {}) {
  const L = [weekly ? '🌍 FX WEEKLY OUTLOOK — XAU/USD · CAD/JPY' : '🌍 FX MORNING BRIEF — XAU/USD · CAD/JPY'];
  L.push('Context for your own strategy — not trade signals.', '');
  for (const key of Object.keys(FX.pairs)) {
    if (!snap.pairs[key]) {
      L.push(`⚠️ ${FX.pairs[key].name}: price data unavailable this run`, '');
      continue;
    }
    L.push(...pairBlock(key, snap.pairs[key]), '');
  }
  const d = snap.drivers;
  const dl = Object.entries(FX.drivers).filter(([k]) => d[k]).map(([k, v]) => `${arrow(d[k].d1)} ${v.name} ${sgn(d[k].d1)} (5d ${sgn(d[k].d5)})`);
  if (dl.length) L.push('📊 DRIVERS', ...dl.map((x) => `• ${x}`), '');
  if (snap.cot) {
    const c = snap.cot;
    const lines = [];
    if (c.XAUUSD?.length >= 2) lines.push(`• Gold: specs net ${c.XAUUSD[0].net.toLocaleString('en-US')} (${c.XAUUSD[0].net >= c.XAUUSD[1].net ? 'adding' : 'trimming'} longs)`);
    if (c.CADJPY?.length >= 2) lines.push(`• CAD vs JPY: specs net CAD ${c.CADJPY[0].cad.toLocaleString('en-US')} · net JPY ${c.CADJPY[0].jpy.toLocaleString('en-US')}`);
    if (lines.length) L.push(`🧾 POSITIONING (CFTC, week of ${(c.XAUUSD || c.CADJPY)[0].date})`, ...lines, '');
  }
  const ev = (snap.events || []).filter((e) => FX.calendar.briefImpact.includes(e.impact));
  const horizon = weekly ? 7 : 1.2;
  const upcoming = ev.filter((e) => e.at >= snap.at - 3_600_000 && e.at <= snap.at + horizon * 86_400_000);
  L.push(weekly ? '📅 THIS WEEK (USD · CAD · JPY, high + medium)' : '📅 NEXT 24H (USD · CAD · JPY)');
  if (upcoming.length) for (const e of upcoming.slice(0, weekly ? 25 : 12)) L.push(eventLine(e));
  else L.push(snap.calendarOk === false ? '⚠️ calendar unavailable this run' : 'No high/medium-impact releases.');
  if (snap.headlines?.length) {
    L.push('', '📰 HEADLINES');
    for (const h of snap.headlines.slice(0, 8)) L.push(`• ${h.title}${h.source ? ` — ${h.source}` : ''}`);
  }
  const bad = Object.entries(snap.health || {}).filter(([, v]) => !v.ok).map(([k]) => k);
  if (bad.length) L.push('', `⚠️ Sources down this run: ${bad.slice(0, 6).join(', ')}`);
  return L.join('\n');
}

export function eventSoonMessage(e, minutes) {
  const pairs = Object.entries(FX.pairs).filter(([, p]) => p.currencies.includes(e.country)).map(([, p]) => p.name);
  return [
    `⏰ HIGH-IMPACT IN ${minutes} MIN — ${flag[e.country] || ''} ${e.country} ${e.title}`,
    `${local(e.at)}${e.forecast ? ` · forecast ${e.forecast}` : ''}${e.previous ? ` · previous ${e.previous}` : ''}`,
    `Moves: ${pairs.join(', ') || 'USD pairs / gold'}. Expect a spread widening and a fast first move — the first spike often reverses.`,
  ].join('\n');
}

export function eventResultMessage(e) {
  const a = parseFloat(e.actual);
  const f = parseFloat(e.forecast);
  const beat = Number.isFinite(a) && Number.isFinite(f) ? (a > f ? 'above' : a < f ? 'below' : 'in line with') : null;
  return [
    `📢 RELEASED — ${flag[e.country] || ''} ${e.country} ${e.title}`,
    `Actual ${e.actual}${e.forecast ? ` vs forecast ${e.forecast}` : ''}${e.previous ? ` (previous ${e.previous})` : ''}${beat ? ` → ${beat} expectations` : ''}`,
  ].join('\n');
}

export function levelBreakMessage(key, lvlName, level, dir, price) {
  return `📐 ${FX.pairs[key].name} broke ${dir === 'up' ? 'ABOVE' : 'BELOW'} the ${lvlName} (${fmt(key, level)}) — now ${fmt(key, price)}.\nStructure change: watch whether it holds on a close or snaps back (liquidity grab).`;
}

export function fastMoveMessage(key, movePct, atrShare, hours, price) {
  return `⚡ ${FX.pairs[key].name} moved ${sgn(movePct)} in ${hours}h — about ${Math.round(atrShare * 100)}% of its normal daily range. Now ${fmt(key, price)}.\nCheck the headlines / calendar for the cause before acting.`;
}

export function driverShockMessage(key, m) {
  const D = FX.drivers[key];
  const affected = Object.entries(FX.pairs).filter(([, p]) => p.drivers[key]).map(([, p]) => `${p.name} (${p.drivers[key] > 0 ? 'same direction' : 'opposite'})`);
  return `🌐 ${D.name} ${sgn(m.d1)} today — a big move for it.\nUsually affects: ${affected.join(', ')}.`;
}

export function headlineMessage(h, pairs) {
  return `📰 ${pairs.join(' · ')} — ${h.title}\n${h.source ? `${h.source} · ` : ''}${h.at ? local(h.at) : ''}${h.link ? `\n${h.link}` : ''}`;
}
