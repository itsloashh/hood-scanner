// ════════════════════════════════════════════════════════════
//  BUDGET ASSISTANT — bills with due dates, paycheque sorting, leisure priorities,
//  spending log, reminders. Stored in the Worker's private KV (key "budget") —
//  never in the public repo.
// ════════════════════════════════════════════════════════════
const TZ = 'America/Toronto';
const DAY = 86_400_000;
const PAY_DAYS = { weekly: 7, biweekly: 14, semimonthly: 15.22, monthly: 30.44 };
const PAY_NAMES = { weekly: 'every week', biweekly: 'every 2 weeks', semimonthly: 'twice a month', monthly: 'once a month' };
const BILL_FREQ = { monthly: 'every month', biweekly: 'every 2 weeks', weekly: 'every week' };
const BUCKETS = { spending: '🛍 Spending', leisure: '🎉 Leisure', investing: '📈 Investing' };
const ALL_BUCKETS = { essentials: '🛒 Essentials', ...BUCKETS };

export const money = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const r2 = (v) => Math.round(v * 100) / 100;
const cap = (s) => s.replace(/^\p{L}/u, (c) => c.toUpperCase());

// ── dates in Toronto time, as YYYY-MM-DD strings ─────────────
export function today(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const toMs = (d) => Date.parse(`${d}T12:00:00Z`);
const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
const addDays = (d, n) => new Date(toMs(d) + n * DAY).toISOString().slice(0, 10);
const nice = (d) => new Date(toMs(d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th'}`;

// next date (≥ from) with this day of month; months without the 31st use their last day
export function nextDue(day, from) {
  const [y, m] = from.split('-').map(Number);
  for (let k = 0; k < 3; k++) {
    const yy = y + Math.floor((m - 1 + k) / 12);
    const mm = ((m - 1 + k) % 12) + 1;
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const d = `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
    if (d >= from) return d;
  }
  return null;
}
// ── paydays: anchored to a date you set ("next payday Fri Oct 23"), then every interval ──
const STEP = { weekly: 7, biweekly: 14 };
// first payday strictly after `d` (or on/after with inclusive)
export function nextPayAfter(b, d, inclusive = false) {
  const freq = b.pay.freq;
  const anchor = b.pay.anchor;
  if (anchor) {
    if (STEP[freq]) {
      const step = STEP[freq];
      const diff = daysBetween(anchor, d);
      let k = Math.floor(diff / step);
      let cand = addDays(anchor, k * step);
      while (inclusive ? cand < d : cand <= d) cand = addDays(anchor, ++k * step);
      return cand;
    }
    const day = Number(anchor.slice(8));
    if (freq === 'monthly') return nextDue(day, inclusive ? d : addDays(d, 1));
    // twice a month: the anchor day and 15 days later, each month
    const a = nextDue(day, inclusive ? d : addDays(d, 1));
    const second = ((day + 14) % 31) + 1;
    const c = nextDue(second, inclusive ? d : addDays(d, 1));
    return a < c ? a : c;
  }
  const base = b.pay.last && b.pay.last <= d ? b.pay.last : d;
  let cand = addDays(base, Math.round(PAY_DAYS[freq] || 14));
  while (inclusive ? cand < d : cand <= d) cand = addDays(cand, Math.round(PAY_DAYS[freq] || 14));
  return cand;
}
export const isPayday = (b, d) => Boolean(b.pay.anchor) && nextPayAfter(b, d, true) === d;

// "Oct 23" · "October 23rd, 2026" · "2026-10-23" · "10/23" · "Friday" · "tomorrow"
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function parseDate(text, on = today()) {
  const t = String(text).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  const pad = (n) => String(n).padStart(2, '0');
  const yNow = Number(on.slice(0, 4));
  const fix = (y, m, d) => {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    let iso = `${y}-${pad(m)}-${pad(d)}`;
    if (!y || iso < addDays(on, -1)) iso = `${(y || yNow) + (iso < on ? 1 : 0)}-${pad(m)}-${pad(d)}`;
    return iso;
  };
  let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
  if (m) return m[3] ? `${m[3]}-${pad(MONTHS.indexOf(m[1]) + 1)}-${pad(m[2])}` : fix(yNow, MONTHS.indexOf(m[1]) + 1, Number(m[2]));
  m = t.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:,?\s+(\d{4}))?/);
  if (m) return m[3] ? `${m[3]}-${pad(MONTHS.indexOf(m[2]) + 1)}-${pad(m[1])}` : fix(yNow, MONTHS.indexOf(m[2]) + 1, Number(m[1]));
  m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) return m[3] ? `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[1])}-${pad(m[2])}` : fix(yNow, Number(m[1]), Number(m[2]));
  if (/\btoday\b/.test(t)) return on;
  if (/\btomorrow\b/.test(t)) return addDays(on, 1);
  m = t.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*/);
  if (m) {
    const target = WEEKDAYS.indexOf(m[1]);
    const cur = new Date(toMs(on)).getUTCDay();
    return addDays(on, (target - cur + 7) % 7);
  }
  return null;
}

// the due date after this one
const followingDue = (bill) => (bill.freq === 'weekly' ? addDays(bill.nextDue, 7) : bill.freq === 'biweekly' ? addDays(bill.nextDue, 14) : nextDue(bill.day, addDays(bill.nextDue, 1)));
const monthlyCost = (bill) => (bill.freq === 'weekly' ? (bill.amount * 52) / 12 : bill.freq === 'biweekly' ? (bill.amount * 26) / 12 : bill.amount);
const billWhen = (x) => (x.freq && x.freq !== 'monthly' ? BILL_FREQ[x.freq] : `on the ${ordinal(x.day)}`);

export function freshBudget() {
  return {
    bills: [], essentials: [], fun: [],
    split: { spending: 40, leisure: 30, investing: 30 },
    pay: { freq: 'biweekly', last: null },
    balances: { essentials: 0, spending: 0, leisure: 0, investing: 0 },
    history: [], log: [], spends: [], awaiting: null, nextId: 1,
  };
}
// older saved budgets → current shape
function normalize(b) {
  const f = freshBudget();
  for (const k of Object.keys(f)) if (b[k] === undefined) b[k] = f[k];
  for (const x of b.bills) x.freq ||= 'monthly';
  for (const x of b.fun) x.balance ||= 0;
  return b;
}

// ── reading what you type ─────────────────────────────────────
const AMOUNT = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
const num = (m) => Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);

export function parseAmount(text) {
  const m = [...String(text).matchAll(AMOUNT)];
  return m.length ? num(m[0]) : null;
}

const FREQ_RE = /(every\s+(?:2|two|other)\s+weeks?|every\s+other\s+week|bi-?weekly|every\s+week|weekly|every\s+month|monthly|a\s+month|per\s+month)/i;
const freqOf = (s) => (!s ? null : /2|two|other|bi/i.test(s) ? 'biweekly' : /week/i.test(s) ? 'weekly' : 'monthly');
// one bill = name, amount, then a day of month and/or how often — several can come in one message
const BILL_RE = new RegExp(
  String.raw`([\p{L}][\p{L}&'\- ]*?)\s*\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?` + // name + amount
    String.raw`(?:\s*${FREQ_RE.source})?` + // optional "every 2 weeks"
    String.raw`(?:\s*(?:due\s+)?(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?![\d.,]))?`, // optional day of month
  'giu'
);
const STOP = /\b(bill|bills|due|on|the|is|for|of|and|my|a|it|payment\s+of)\b/gi;

// "Rent 1200 1st, car insurance 110 15th hydro 75 21st" · "credit card 150 every 2 weeks"
export function parseBills(text) {
  const out = [];
  const parts = String(text).replace(/\s+and\s+/gi, '\n').split(/[\n;]+|,(?!\d{3})/); // "$1,050" stays one number
  for (const part of parts) {
    for (const m of part.matchAll(BILL_RE)) {
      const name = cap(m[1].replace(STOP, ' ').replace(/\s+/g, ' ').trim());
      const amount = r2(Number(`${m[2].replace(/,/g, '')}${m[3] ? `.${m[3]}` : ''}`));
      const freq = freqOf(m[4]) || 'monthly';
      const day = m[5] ? Number(m[5]) : null;
      if (!name || !(amount > 0)) continue;
      if (freq === 'monthly' && !(day >= 1 && day <= 31)) continue;
      out.push({ name, amount, freq, day: day && day <= 31 ? day : null });
    }
  }
  return out;
}
export const parseBill = (text) => {
  const b = parseBills(text)[0];
  return b ? { name: b.name, amount: b.amount, day: b.day } : null;
};

// "Groceries 400" — monthly essential
export function parseEssential(text) {
  const amount = parseAmount(text);
  const name = String(text).replace(AMOUNT, ' ').replace(/\b(a|per|every|month|monthly|\/mo|mo)\b/gi, ' ').replace(/[^\p{L}\p{N}&' -]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!name || !(amount > 0)) return null;
  return { name: cap(name), monthly: r2(amount) };
}

// "Golf 40%" or "Golf 40" — a leisure priority taking 40% of each cheque's leisure money
export function parseFun(text) {
  const m = String(text).match(/^\s*([\p{L}][\p{L}\p{N}&' -]*?)\s+(\d{1,3})\s*%?\s*$/u);
  if (!m) return null;
  const pct = Number(m[2]);
  if (!(pct > 0 && pct <= 100)) return null;
  return { name: cap(m[1].trim()), pct };
}

// ── the paycheque sort ────────────────────────────────────────
// 1) bills: each gets its share so it's fully funded by its due date — bills due before
//    the next payday get everything they still need. Earliest due first.
// 2) essentials: monthly total ÷ paycheques per month.
// 3) the rest splits into spending / leisure / investing by your percentages.
// 4) leisure then feeds your priorities in order (Golf 40%…); what's left stays general leisure.
export function allocate(b, amount, on = today()) {
  const interval = PAY_DAYS[b.pay.freq] || 14;
  const nextPay = nextPayAfter(b, on);
  let left = r2(amount);
  const bills = [];
  for (const bill of [...b.bills].sort((x, y) => (x.nextDue < y.nextDue ? -1 : 1))) {
    const need = r2(Math.max(0, bill.amount - (bill.saved || 0)));
    if (!need) continue;
    const daysToDue = daysBetween(on, bill.nextDue);
    const paysLeft = bill.nextDue < nextPay ? 1 : Math.max(1, Math.ceil(daysToDue / interval));
    const want = r2(need / paysLeft);
    const give = r2(Math.min(want, left));
    left = r2(left - give);
    bills.push({ id: bill.id, name: bill.name, due: bill.nextDue, give, want, fullyFunded: r2((bill.saved || 0) + give) >= bill.amount, urgent: bill.nextDue < nextPay });
  }
  const perMonth = 30.44 / interval;
  const essWant = r2(b.essentials.reduce((s, e) => s + e.monthly, 0) / perMonth);
  const essentials = r2(Math.min(essWant, left));
  left = r2(left - essentials);
  const pct = b.split;
  const total = (pct.spending || 0) + (pct.leisure || 0) + (pct.investing || 0) || 100;
  const spending = r2((left * (pct.spending || 0)) / total);
  const leisure = r2((left * (pct.leisure || 0)) / total);
  const investing = r2(left - spending - leisure);
  // leisure priorities, top first, never more than 100% of the leisure money
  const fun = [];
  let pctLeft = 100;
  let funTotal = 0;
  for (const f of b.fun || []) {
    const p = Math.min(f.pct, pctLeft);
    pctLeft -= p;
    const give = r2((leisure * p) / 100);
    funTotal = r2(funTotal + give);
    fun.push({ id: f.id, name: f.name, pct: p, wanted: f.pct, give });
  }
  const leisureGeneral = r2(leisure - funTotal);
  const short = r2(bills.reduce((s, x) => s + (x.want - x.give), 0) + (essWant - essentials));
  return { amount: r2(amount), on, nextPay, bills, essentials, essWant, spending, leisure, leisureGeneral, fun, investing, short: short > 0.005 ? short : 0 };
}

export function applyPaycheque(b, a) {
  for (const x of a.bills) {
    const bill = b.bills.find((y) => y.id === x.id);
    if (bill) bill.saved = r2((bill.saved || 0) + x.give);
  }
  for (const x of a.fun || []) {
    const f = b.fun.find((y) => y.id === x.id);
    if (f) f.balance = r2((f.balance || 0) + x.give);
  }
  b.balances.essentials = r2(b.balances.essentials + a.essentials);
  b.balances.spending = r2(b.balances.spending + a.spending);
  b.balances.leisure = r2(b.balances.leisure + (a.leisureGeneral ?? a.leisure));
  b.balances.investing = r2(b.balances.investing + a.investing);
  const prevLast = b.pay.last || null;
  b.pay.last = a.on;
  b.history.unshift({ on: a.on, amount: a.amount, prevLast, bills: a.bills.map((x) => ({ id: x.id, name: x.name, give: x.give })), essentials: a.essentials, spending: a.spending, leisure: a.leisure, leisureGeneral: a.leisureGeneral ?? a.leisure, fun: (a.fun || []).map((x) => ({ id: x.id, name: x.name, give: x.give })), investing: a.investing, short: a.short });
  b.history = b.history.slice(0, 30);
}

// Take back the most recent paycheque exactly as it was sorted (for a test or a typo)
export function undoLastPay(b) {
  const h = b.history[0];
  if (!h) return null;
  const find = (list, x) => list.find((y) => (x.id != null && y.id === x.id)) || list.find((y) => y.name === x.name);
  for (const x of h.bills || []) {
    const bill = find(b.bills, x);
    if (bill) bill.saved = r2(Math.max(0, (bill.saved || 0) - x.give));
  }
  for (const x of h.fun || []) {
    const f = find(b.fun, x);
    if (f) f.balance = r2((f.balance || 0) - x.give);
  }
  const funTotal = (h.fun || []).reduce((s, x) => s + x.give, 0);
  b.balances.essentials = r2(b.balances.essentials - h.essentials);
  b.balances.spending = r2(b.balances.spending - h.spending);
  b.balances.leisure = r2(b.balances.leisure - (h.leisureGeneral ?? h.leisure - funTotal));
  b.balances.investing = r2(b.balances.investing - h.investing);
  b.history.shift();
  b.pay.last = h.prevLast !== undefined ? h.prevLast : b.history[0]?.on || null;
  return h;
}

// Bills whose due date passed: paid from their set-aside money, rolled to the next due date
export function rollBills(b, on = today()) {
  const paid = [];
  for (const bill of b.bills) {
    let guard = 0;
    while (bill.nextDue && bill.nextDue < on && guard++ < 60) {
      const covered = Math.min(bill.saved || 0, bill.amount);
      paid.push({ name: bill.name, amount: bill.amount, due: bill.nextDue, covered: r2(covered), short: r2(bill.amount - covered) });
      bill.saved = r2((bill.saved || 0) - covered);
      bill.nextDue = followingDue(bill);
    }
  }
  if (paid.length) {
    b.log.unshift(...paid.map((p) => ({ ...p, at: on })));
    b.log = b.log.slice(0, 50);
  }
  return paid;
}

// ── KV ────────────────────────────────────────────────────────
export async function loadBudget(env) {
  if (!env.PAPER) return null;
  return normalize((await env.PAPER.get('budget', 'json')) || freshBudget());
}
export const saveBudget = (env, b) => env.PAPER.put('budget', JSON.stringify(b));

// ── screens (every one starts "BUDGET ·" so taps edit in place) ──
const btn = (text, data) => ({ text, callback_data: data });
const HOME = [btn('💰 Budget home', 'bg')];
const nextPayOf = (b, on = today()) => (b.pay.anchor || b.pay.last ? nextPayAfter(b, on, true) : null);
const dueTag = (on, d) => {
  const n = daysBetween(on, d);
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
};

export function homeScreen(b, on = today()) {
  const L = ['BUDGET · 💰 BUDGET', ''];
  const np = nextPayOf(b, on);
  L.push(`📅 Paid ${PAY_NAMES[b.pay.freq]}`);
  if (b.pay.last) L.push(`• Last payday: ${nice(b.pay.last)}`);
  if (np) L.push(`• Next payday: ${b.pay.anchor ? '' : '≈ '}${nice(np)}${np === on ? ' (today!)' : ` (${dueTag(on, np)})`}`);
  else L.push('• Next payday: not set — 📅 Pay schedule → Set next payday');
  L.push('', '💼 WHERE YOUR MONEY IS');
  L.push(`• 🧾 Set aside for bills: ${money(b.bills.reduce((s, x) => s + (x.saved || 0), 0))}`);
  L.push(`• 🛒 Essentials: ${money(b.balances.essentials)}`);
  L.push(`• 🛍 Spending: ${money(b.balances.spending)}`);
  const funTotal = b.fun.reduce((s, f) => s + (f.balance || 0), 0);
  L.push(`• 🎉 Leisure: ${money(b.balances.leisure + funTotal)}`);
  for (const f of b.fun) L.push(`    ◦ ${f.name}: ${money(f.balance || 0)}`);
  if (b.fun.length) L.push(`    ◦ General: ${money(b.balances.leisure)}`);
  L.push(`• 📈 Investing: ${money(b.balances.investing)}`);
  const since = b.pay.last || '0000';
  const spent = (b.spends || []).filter((e) => e.on >= since).reduce((s, e) => s + e.amount, 0);
  if (spent) L.push(`• 💸 Spent since last payday: ${money(spent)}`);
  L.push('', '🧾 NEXT BILLS');
  if (!b.bills.length) L.push('• None yet — tap ➕ Add bill');
  for (const x of [...b.bills].sort((p, q) => (p.nextDue < q.nextDue ? -1 : 1)).slice(0, 6)) {
    const ready = (x.saved || 0) >= x.amount;
    L.push(`${ready ? '✅' : daysBetween(on, x.nextDue) <= 7 ? '⚠️' : '•'} ${x.name} — ${money(x.amount)}`, `    ${nice(x.nextDue)} (${dueTag(on, x.nextDue)}) · ${money(x.saved || 0)} set aside`);
  }
  return {
    text: L.join('\n'),
    kb: [
      [btn('💵 I got paid', 'bgp'), btn('💸 Log spending', 'bgw')],
      [btn('🧾 Bills', 'bgb'), btn('➕ Add bill', 'bga')],
      [btn('🎉 Leisure priorities', 'bgl'), btn('🛒 Essentials', 'bge')],
      [btn('⚖️ Split %', 'bgs'), btn('📅 Pay schedule', 'bgf')],
      [btn('📜 History', 'bgh'), btn('🔄 Refresh', 'bg')],
    ],
  };
}

export function paidScreen(b, a) {
  const L = [`BUDGET · 💵 PAYCHEQUE ${money(a.amount)} — SORTED`, ''];
  if (a.bills.length) {
    L.push(`🧾 BILLS — ${money(a.bills.reduce((s, x) => s + x.give, 0))}`);
    for (const x of a.bills) L.push(`• ${x.name}: ${money(x.give)}`, `    due ${nice(x.due)}${x.fullyFunded ? ' · ✅ fully covered' : x.give < x.want ? ` · ⚠️ short ${money(x.want - x.give)}` : ''}`);
    L.push('');
  }
  L.push(`🛒 ESSENTIALS — ${money(a.essentials)}${a.essentials < a.essWant ? ` (needed ${money(a.essWant)})` : ''}`, '');
  L.push('✨ WHAT\'S LEFT');
  L.push(`• 🛍 Spending: ${money(a.spending)}`);
  L.push(`• 🎉 Leisure: ${money(a.leisure)}`);
  for (const f of a.fun || []) L.push(`    ◦ ${f.name} (${f.pct}%): ${money(f.give)}${f.pct < f.wanted ? ' — capped, higher priorities used the rest' : ''}`);
  if (a.fun?.length) L.push(`    ◦ General: ${money(a.leisureGeneral)}`);
  L.push(`• 📈 Investing: ${money(a.investing)}`);
  if (a.short) L.push('', `⚠️ This paycheque came up ${money(a.short)} short of what bills + essentials need before the next one. Bills were covered first, earliest due first.`);
  L.push('', `📅 Next payday ≈ ${nice(a.nextPay)}`);
  return { text: L.join('\n'), kb: [HOME] };
}

export function billsScreen(b, on = today()) {
  const L = ['BUDGET · 🧾 BILLS', ''];
  if (!b.bills.length) L.push('• None yet.');
  const list = [...b.bills].sort((p, q) => (p.nextDue < q.nextDue ? -1 : 1));
  for (const x of list) {
    L.push(`${(x.saved || 0) >= x.amount ? '✅' : '•'} ${x.name} — ${money(x.amount)} ${billWhen(x)}`, `    next ${nice(x.nextDue)} (${dueTag(on, x.nextDue)}) · ${money(x.saved || 0)} set aside`);
  }
  if (b.bills.length) L.push('', `Total ≈ ${money(b.bills.reduce((s, x) => s + monthlyCost(x), 0))} a month`);
  L.push('', 'Tap a bill to remove it or mark it paid early.');
  const kb = [];
  for (let i = 0; i < list.length; i += 2) kb.push(list.slice(i, i + 2).map((x) => btn(`${x.name} ${money(x.amount)}`, `bgi:${x.id}`)));
  kb.push([btn('➕ Add bill', 'bga'), ...HOME]);
  return { text: L.join('\n'), kb };
}

export function billItemScreen(b, id) {
  const x = b.bills.find((y) => y.id === id);
  if (!x) return billsScreen(b);
  return {
    text: `BUDGET · 🧾 ${x.name}\n\n• ${money(x.amount)} ${billWhen(x)}\n• Next due: ${nice(x.nextDue)}\n• Set aside: ${money(x.saved || 0)}`,
    kb: [[btn('✅ Paid it', `bgk:${id}`), btn('🗑 Remove', `bgx:${id}`)], [btn('⬅️ Bills', 'bgb'), ...HOME]],
  };
}

export function essentialsScreen(b) {
  const L = ['BUDGET · 🛒 ESSENTIALS (monthly)', 'Anything you need every month that isn\'t a fixed bill — groceries, gas, transit…', ''];
  if (!b.essentials.length) L.push('• None yet.');
  for (const e of b.essentials) L.push(`• ${e.name}: ${money(e.monthly)} / month`);
  const total = b.essentials.reduce((s, e) => s + e.monthly, 0);
  if (b.essentials.length) L.push('', `Total ${money(total)} / month`, `≈ ${money(total / (30.44 / PAY_DAYS[b.pay.freq]))} from each paycheque`);
  const kb = [];
  for (let i = 0; i < b.essentials.length; i += 2) kb.push(b.essentials.slice(i, i + 2).map((e) => btn(`🗑 ${e.name}`, `bgy:${e.id}`)));
  kb.push([btn('➕ Add essential', 'bgn'), ...HOME]);
  return { text: L.join('\n'), kb };
}

// ── leisure priorities ────────────────────────────────────────
export function funScreen(b) {
  const L = ['BUDGET · 🎉 LEISURE PRIORITIES', `Each paycheque's leisure money (${b.split.leisure}% of what's left) is shared out top to bottom; anything left stays as general leisure.`, ''];
  if (!b.fun.length) L.push('• None yet — add one, e.g. "Golf 40%".');
  let used = 0;
  b.fun.forEach((f, i) => {
    const p = Math.min(f.pct, 100 - used);
    used += p;
    L.push(`${i + 1}. ${f.name} — ${f.pct}% of leisure${p < f.pct ? ` (gets ${p}% — higher priorities use the rest)` : ''}`, `    ${money(f.balance || 0)} saved up`);
  });
  if (b.fun.length) L.push('', `• General leisure: ${Math.max(0, 100 - used)}% · ${money(b.balances.leisure)}`);
  L.push('', 'Tap one to change its %, move it up, or remove it.');
  const kb = b.fun.map((f, i) => [btn(`${i + 1}. ${f.name} · ${f.pct}%`, `bgo:${f.id}`)]);
  kb.push([btn('➕ Add priority', 'bgm'), ...HOME]);
  return { text: L.join('\n'), kb };
}

export function funItemScreen(b, id) {
  const i = b.fun.findIndex((f) => f.id === id);
  if (i < 0) return funScreen(b);
  const f = b.fun[i];
  const opts = [10, 20, 25, 30, 40, 50, 60, 75, 100];
  return {
    text: `BUDGET · 🎉 ${f.name}\n\n• Priority #${i + 1}\n• Gets ${f.pct}% of each paycheque's leisure money\n• Saved up: ${money(f.balance || 0)}\n\nPick a new %:`,
    kb: [
      opts.slice(0, 5).map((p) => btn(`${f.pct === p ? '✅ ' : ''}${p}%`, `bgr:${id}:${p}`)),
      opts.slice(5).map((p) => btn(`${f.pct === p ? '✅ ' : ''}${p}%`, `bgr:${id}:${p}`)),
      [...(i > 0 ? [btn('⬆️ Higher priority', `bgt:${id}`)] : []), btn('🗑 Remove', `bgz:${id}`)],
      [btn('⬅️ Priorities', 'bgl'), ...HOME],
    ],
  };
}

const SPLITS = [[40, 30, 30], [50, 30, 20], [50, 20, 30], [60, 20, 20], [34, 33, 33], [30, 30, 40]];
export function splitScreen(b) {
  const s = b.split;
  return {
    text: `BUDGET · ⚖️ WHAT'S LEFT GETS SPLIT\n\nAfter bills and essentials, the rest of each paycheque goes:\n• 🛍 Spending ${s.spending}%\n• 🎉 Leisure ${s.leisure}%\n• 📈 Investing ${s.investing}%\n\nPick a split (spending / leisure / investing):`,
    kb: [
      ...[0, 3].map((i) => SPLITS.slice(i, i + 3).map(([a, c, d]) => btn(`${s.spending === a && s.leisure === c ? '✅ ' : ''}${a}/${c}/${d}`, `bgv:${a}:${c}:${d}`))),
      HOME,
    ],
  };
}

export function payScreen(b, on = today()) {
  const np = nextPayOf(b, on);
  const upcoming = [];
  if (b.pay.anchor) {
    let d = np;
    for (let i = 0; i < 4 && d; i++) {
      upcoming.push(nice(d));
      d = nextPayAfter(b, d);
    }
  }
  return {
    text: `BUDGET · 📅 PAY SCHEDULE\n\n• Paid: ${PAY_NAMES[b.pay.freq]}\n• Next payday: ${np ? nice(np) : 'not set'}${upcoming.length > 1 ? `\n• Then: ${upcoming.slice(1).join(' · ')}` : ''}\n\nThis sets how much each paycheque puts aside for bills and essentials. Tap how often you're paid, and set your next payday so the dates are exact.`,
    kb: [
      [btn('📅 Set next payday', 'bgd')],
      Object.keys(PAY_NAMES).slice(0, 2).map((k) => btn(`${b.pay.freq === k ? '✅ ' : ''}${PAY_NAMES[k]}`, `bgq:${k}`)),
      Object.keys(PAY_NAMES).slice(2).map((k) => btn(`${b.pay.freq === k ? '✅ ' : ''}${PAY_NAMES[k]}`, `bgq:${k}`)),
      HOME,
    ],
  };
}

export function historyScreen(b) {
  const L = ['BUDGET · 📜 HISTORY', ''];
  if (!b.history.length && !b.log.length && !b.spends?.length) L.push('• Nothing yet.');
  if (b.history.length) L.push('💵 PAYCHEQUES');
  for (const h of b.history.slice(0, 6)) {
    L.push(`• ${nice(h.on)} — ${money(h.amount)}`, `    bills ${money(h.bills.reduce((s, x) => s + x.give, 0))} · essentials ${money(h.essentials)} · spend ${money(h.spending)} · leisure ${money(h.leisure)} · invest ${money(h.investing)}${h.short ? ` · ⚠️ short ${money(h.short)}` : ''}`);
  }
  if (b.spends?.length) {
    L.push('', '💸 SPENDING');
    for (const e of b.spends.slice(0, 12)) L.push(`• ${nice(e.on)} ${money(e.amount)} — ${bucketName(b, e.bucket)}${e.note ? ` · ${e.note}` : ''}`);
  }
  if (b.log.length) {
    L.push('', '🧾 BILLS PAID');
    for (const p of b.log.slice(0, 8)) L.push(`• ${nice(p.due)} ${p.name} ${money(p.amount)}${p.short ? ` — ⚠️ ${money(p.short)} wasn't set aside` : ' ✅'}`);
  }
  const kb = [];
  if (b.history.length) kb.push([btn(`↩️ Undo last paycheque (${money(b.history[0].amount)})`, 'bgj')]);
  kb.push(HOME);
  return { text: L.join('\n'), kb };
}

// ── spending: "40 drinks" · "/spent 60 golf" ─────────────────
const BUCKET_WORDS = [
  ['essentials', /essential|grocer|food|gas\b|fuel|transit|uber|bus|pharmac|household|toiletr|laundry/i],
  ['leisure', /leisure|fun|bar|drink|beer|restaurant|dinner|movie|concert|game|trip|travel|date|party/i],
  ['investing', /invest|stock|crypto|etf|tfsa|rrsp|savings|save/i],
  ['spending', /spend|shop|clothes|amazon|misc|other/i],
];
const bucketName = (b, k) => {
  if (String(k).startsWith('fun:')) {
    const f = b.fun.find((x) => x.id === Number(k.slice(4)));
    return `🎉 ${f ? f.name : 'Leisure'}`;
  }
  return ALL_BUCKETS[k] || k;
};
const balanceOf = (b, k) => (String(k).startsWith('fun:') ? b.fun.find((x) => x.id === Number(k.slice(4)))?.balance ?? 0 : b.balances[k] ?? 0);

export function parseSpend(text, bucket = null, b = null) {
  const amount = parseAmount(text);
  if (!(amount > 0)) return null;
  let k = bucket;
  if (!k && b?.fun?.length) {
    const f = b.fun.find((x) => new RegExp(`\\b${x.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
    if (f) k = `fun:${f.id}`;
  }
  if (!k) for (const [key, re] of BUCKET_WORDS) if (re.test(text)) { k = key; break; }
  const note = String(text).replace(AMOUNT, ' ').replace(/\b(essentials?|spending|leisure|investing|invest|on|for|at|spent)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return { amount: r2(amount), bucket: k || 'spending', note: note.slice(0, 40) };
}

export function logSpend(b, sp, on = today()) {
  b.spends ||= [];
  if (String(sp.bucket).startsWith('fun:')) {
    const f = b.fun.find((x) => x.id === Number(sp.bucket.slice(4)));
    if (f) f.balance = r2((f.balance || 0) - sp.amount);
    else sp.bucket = 'leisure';
  }
  if (!String(sp.bucket).startsWith('fun:')) b.balances[sp.bucket] = r2((b.balances[sp.bucket] || 0) - sp.amount);
  const entry = { id: b.nextId++, on, ...sp };
  b.spends.unshift(entry);
  b.spends = b.spends.slice(0, 100);
  return entry;
}

function undoSpend(b, id) {
  const e = (b.spends || []).find((x) => x.id === id);
  if (!e) return;
  if (String(e.bucket).startsWith('fun:')) {
    const f = b.fun.find((x) => x.id === Number(e.bucket.slice(4)));
    if (f) f.balance = r2((f.balance || 0) + e.amount);
  } else b.balances[e.bucket] = r2((b.balances[e.bucket] || 0) + e.amount);
  b.spends = b.spends.filter((x) => x.id !== id);
}

export function spentScreen(b, e) {
  const left = balanceOf(b, e.bucket);
  return {
    text: `BUDGET · 💸 Logged ${money(e.amount)}${e.note ? ` — ${e.note}` : ''}\n\n• From: ${bucketName(b, e.bucket)}\n• Left: ${money(left)}${left < 0 ? `\n\n⚠️ ${money(-left)} over — top it up from the next paycheque.` : ''}\n\nSend another amount, or tap Done.`,
    kb: [[btn('↩️ Undo', `bgu:${e.id}`), btn('✔️ Done', 'bg')]],
  };
}

export function spendPickScreen(b) {
  const L = ['BUDGET · 💸 LOG SPENDING — which bucket?', ''];
  for (const [k, l] of Object.entries(ALL_BUCKETS)) L.push(`• ${l}: ${money(b.balances[k] || 0)} left`);
  for (const f of b.fun) L.push(`    ◦ ${f.name}: ${money(f.balance || 0)} left`);
  L.push('', 'Or just type it — "40 drinks", "85 groceries", "60 golf" — and I\'ll pick the bucket.');
  const kb = [
    [btn(ALL_BUCKETS.essentials, 'bgw:essentials'), btn(ALL_BUCKETS.spending, 'bgw:spending')],
    [btn(ALL_BUCKETS.leisure, 'bgw:leisure'), btn(ALL_BUCKETS.investing, 'bgw:investing')],
  ];
  for (let i = 0; i < b.fun.length; i += 3) kb.push(b.fun.slice(i, i + 3).map((f) => btn(`🎉 ${f.name}`, `bgw:fun-${f.id}`)));
  kb.push(HOME);
  return { text: L.join('\n'), kb };
}

export const ASK = {
  payday: 'BUDGET · 📅 When is your next payday?\n\nSend a date, e.g. Oct 23 · Friday · 2026-10-23',
  pay: 'BUDGET · 💵 How much did you get paid?\n\nSend the amount, e.g. 1850 or $1,850.25',
  bill: 'BUDGET · ➕ Send bills like this (one or several at once):\n\n• Rent 1200 on the 1st\n• Phone $85.50 15th\n• Car insurance 210 due 28\n• Credit card 150 every 2 weeks',
  essential: 'BUDGET · ➕ Send a monthly essential like:\n\n• Groceries 400\n• Gas 160',
  fun: 'BUDGET · 🎉 Send a leisure priority and its share of the leisure money:\n\n• Golf 40%\n• Concerts 20%\n\nThe first one you add is top priority — you can reorder later.',
  spend: (b, k) => `BUDGET · 💸 How much from ${bucketName(b, k)}?\n\ne.g. 40 or "40 green fees"`,
};

// Typed reply while the assistant is waiting for one. Returns a screen, or null if not handled.
export function handleText(b, text, on = today()) {
  normalize(b);
  const t = String(text).trim();
  const kind = b.awaiting;
  if (!kind) return null;
  if (/^(cancel|stop|nevermind|never mind|done)$/i.test(t)) {
    b.awaiting = null;
    return homeScreen(b, on);
  }
  if (kind === 'payday') {
    const d = parseDate(t, on);
    if (!d) return { text: `${ASK.payday}\n\n(Couldn't read a date in "${t}")`, kb: [HOME] };
    b.awaiting = null;
    b.pay.anchor = d;
    return payScreen(b, on);
  }
  if (kind === 'pay') {
    const amount = parseAmount(t);
    if (!(amount > 0)) return { text: `${ASK.pay}\n\n(Couldn't read an amount in "${t}")`, kb: [HOME] };
    b.awaiting = null;
    rollBills(b, on);
    const a = allocate(b, amount, on);
    applyPaycheque(b, a);
    return paidScreen(b, a);
  }
  if (kind === 'bill') {
    const found = parseBills(t);
    if (!found.length) return { text: `${ASK.bill}\n\n(Couldn't read a name, amount and due day in "${t}")`, kb: [HOME] };
    const np = nextPayOf(b) || addDays(on, Math.round(PAY_DAYS[b.pay.freq]));
    const lines = [];
    for (const p of found) {
      const due = p.freq === 'monthly' ? nextDue(p.day, on) : p.day ? nextDue(p.day, on) : np;
      b.bills.push({ id: b.nextId++, name: p.name, amount: p.amount, freq: p.freq, day: p.day || Number(due.slice(8)), nextDue: due, saved: 0 });
      lines.push(`• ${p.name} — ${money(p.amount)} ${p.freq === 'monthly' ? `on the ${ordinal(p.day)}` : BILL_FREQ[p.freq]}`, `    first due ${nice(due)}`);
    }
    return { text: `BUDGET · ✅ Added ${found.length} bill${found.length > 1 ? 's' : ''}:\n\n${lines.join('\n')}\n\nSend more, or tap Done.`, kb: [[btn('✔️ Done', 'bgb')]] };
  }
  if (kind === 'essential') {
    const p = parseEssential(t);
    if (!p) return { text: `${ASK.essential}\n\n(Couldn't read "${t}")`, kb: [HOME] };
    b.essentials.push({ id: b.nextId++, ...p });
    return { text: `BUDGET · ✅ Added ${p.name} — ${money(p.monthly)} / month.\n\nSend another, or tap Done.`, kb: [[btn('✔️ Done', 'bge')]] };
  }
  if (kind === 'fun') {
    const p = parseFun(t);
    if (!p) return { text: `${ASK.fun}\n\n(Couldn't read "${t}" — send a name and a %, e.g. Golf 40%)`, kb: [HOME] };
    b.fun.push({ id: b.nextId++, ...p, balance: 0 });
    return { ...funScreen(b), text: `BUDGET · ✅ Added ${p.name} — ${p.pct}% of leisure (priority #${b.fun.length}).\n\nSend another, or tap Done.`, kb: [[btn('✔️ Done', 'bgl')]] };
  }
  if (kind === 'spend' || kind.startsWith('spend:')) {
    const sp = parseSpend(t, kind.includes(':') ? kind.slice(6) : null, b);
    if (!sp) return { text: `BUDGET · 💸 Couldn't read an amount in "${t}". Send e.g. 40 or "40 drinks".`, kb: [HOME] };
    return spentScreen(b, logSpend(b, sp, on)); // stays listening
  }
  return null;
}

// Button taps (ops start with "bg")
export function handleTap(b, op, a, c, d, on = today()) {
  normalize(b);
  rollBills(b, on);
  if (op === 'bg') {
    b.awaiting = null; // Done / home stops listening for typed replies
    return homeScreen(b, on);
  }
  if (op === 'bgp') { b.awaiting = 'pay'; return { text: ASK.pay, kb: [HOME] }; }
  if (op === 'bga') { b.awaiting = 'bill'; return { text: ASK.bill, kb: [HOME] }; }
  if (op === 'bgn') { b.awaiting = 'essential'; return { text: ASK.essential, kb: [HOME] }; }
  if (op === 'bgm') { b.awaiting = 'fun'; return { text: ASK.fun, kb: [HOME] }; }
  if (op === 'bgw') {
    const k = a ? (a.startsWith('fun-') ? `fun:${a.slice(4)}` : a) : null;
    b.awaiting = k ? `spend:${k}` : 'spend';
    return k ? { text: ASK.spend(b, k), kb: [HOME] } : spendPickScreen(b);
  }
  b.awaiting = null;
  if (op === 'bgu') {
    undoSpend(b, Number(a));
    return homeScreen(b, on);
  }
  if (op === 'bgb') return billsScreen(b, on);
  if (op === 'bgi') return billItemScreen(b, Number(a));
  if (op === 'bgx') {
    b.bills = b.bills.filter((x) => x.id !== Number(a));
    return billsScreen(b, on);
  }
  if (op === 'bgk') {
    const x = b.bills.find((y) => y.id === Number(a));
    if (x) {
      const covered = Math.min(x.saved || 0, x.amount);
      b.log.unshift({ name: x.name, amount: x.amount, due: x.nextDue, covered: r2(covered), short: r2(x.amount - covered), at: on });
      x.saved = r2((x.saved || 0) - covered);
      x.nextDue = followingDue(x);
    }
    return billsScreen(b, on);
  }
  if (op === 'bge') return essentialsScreen(b);
  if (op === 'bgy') {
    b.essentials = b.essentials.filter((e) => e.id !== Number(a));
    return essentialsScreen(b);
  }
  if (op === 'bgl') return funScreen(b);
  if (op === 'bgo') return funItemScreen(b, Number(a));
  if (op === 'bgr') {
    const f = b.fun.find((x) => x.id === Number(a));
    if (f && Number(c) > 0 && Number(c) <= 100) f.pct = Number(c);
    return funItemScreen(b, Number(a));
  }
  if (op === 'bgt') {
    const i = b.fun.findIndex((x) => x.id === Number(a));
    if (i > 0) [b.fun[i - 1], b.fun[i]] = [b.fun[i], b.fun[i - 1]];
    return funItemScreen(b, Number(a));
  }
  if (op === 'bgz') {
    const f = b.fun.find((x) => x.id === Number(a));
    if (f) b.balances.leisure = r2(b.balances.leisure + (f.balance || 0)); // its savings go back to general leisure
    b.fun = b.fun.filter((x) => x.id !== Number(a));
    return funScreen(b);
  }
  if (op === 'bgs') return splitScreen(b);
  if (op === 'bgv') {
    b.split = { spending: Number(a), leisure: Number(c), investing: Number(d) };
    return splitScreen(b);
  }
  if (op === 'bgf') return payScreen(b, on);
  if (op === 'bgd') { b.awaiting = 'payday'; return { text: ASK.payday, kb: [HOME] }; }
  if (op === 'bgj') {
    const h = undoLastPay(b);
    return { ...historyScreen(b), text: `${h ? `BUDGET · ↩️ Took back the ${money(h.amount)} paycheque from ${nice(h.on)} — every bill, bucket and priority is back where it was.` : 'BUDGET · Nothing to undo.'}\n\n${historyScreen(b).text.replace(/^BUDGET · /, '')}` };
  }
  if (op === 'bgq') {
    if (PAY_NAMES[a]) b.pay.freq = a;
    return payScreen(b, on);
  }
  if (op === 'bgh') return historyScreen(b);
  return homeScreen(b, on);
}

// Daily (9 AM Toronto): roll paid bills, remind about bills due today / in 3 days
export function dailyReminders(b, on = today()) {
  normalize(b);
  const paid = rollBills(b, on);
  const payday = isPayday(b, on) && b.pay.last !== on ? [`💵 PAYDAY TODAY — tap 💵 I got paid (or send /paid 1850) and I'll sort it.`] : [];
  const msgs = payday;
  msgs.push(...paid.map((p) => `🧾 ${p.name} ${money(p.amount)} was due ${nice(p.due)} — ${p.short ? `⚠️ only ${money(p.covered)} was set aside` : 'paid from what you set aside ✅'}`));
  for (const x of b.bills) {
    const n = daysBetween(on, x.nextDue);
    if (n === 0 || n === 3) {
      const ready = (x.saved || 0) >= x.amount;
      msgs.push(`⏰ ${x.name} ${money(x.amount)} is due ${n === 0 ? 'TODAY' : `in 3 days (${nice(x.nextDue)})`} — ${ready ? 'fully set aside ✅' : `${money(x.saved || 0)} set aside, ${money(x.amount - (x.saved || 0))} still needed ⚠️`}`);
    }
  }
  return msgs;
}
