// ════════════════════════════════════════════════════════════
//  BUDGET ASSISTANT — bills with due dates, paycheque sorting, reminders.
//  Stored in the Worker's private KV (key "budget") — never in the public repo.
// ════════════════════════════════════════════════════════════
const TZ = 'America/Toronto';
const DAY = 86_400_000;
const PAY_DAYS = { weekly: 7, biweekly: 14, semimonthly: 15.22, monthly: 30.44 };
const PAY_NAMES = { weekly: 'every week', biweekly: 'every 2 weeks', semimonthly: 'twice a month', monthly: 'once a month' };
const BUCKETS = { spending: '🛍 Spending', leisure: '🎉 Leisure', investing: '📈 Investing' };

export const money = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const r2 = (v) => Math.round(v * 100) / 100;

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

export function freshBudget() {
  return {
    bills: [], essentials: [],
    split: { spending: 40, leisure: 30, investing: 30 },
    pay: { freq: 'biweekly', last: null },
    balances: { essentials: 0, spending: 0, leisure: 0, investing: 0 },
    history: [], log: [], spends: [], awaiting: null, nextId: 1,
  };
}

// ── parsing what you type ─────────────────────────────────────
const AMOUNT = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
const num = (m) => Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);

export function parseAmount(text) {
  const m = [...String(text).matchAll(AMOUNT)];
  return m.length ? num(m[0]) : null;
}

// "Rent 1200 on the 1st" · "Phone $85.50 15th" · "Car insurance 210 due 28"
export function parseBill(text) {
  let t = String(text).trim();
  const ord = t.match(/\b(?:on\s+the\s+|on\s+|due\s+(?:on\s+)?(?:the\s+)?)?(\d{1,2})(st|nd|rd|th)\b/i) || t.match(/\b(?:on\s+the\s+|on\s+|due\s+(?:on\s+)?(?:the\s+)?)(\d{1,2})\b/i);
  let day = null;
  if (ord) {
    day = Number(ord[1]);
    t = t.replace(ord[0], ' ');
  }
  const nums = [...t.matchAll(AMOUNT)];
  if (!nums.length) return null;
  let amtMatch = nums.find((m) => m[0].includes('$') || m[2]) || nums[0];
  if (day == null) {
    // two plain numbers: the one ≤31 that isn't the amount is the day
    const other = nums.find((m) => m !== amtMatch && num(m) >= 1 && num(m) <= 31);
    if (other) {
      day = num(other);
      t = t.replace(other[0], ' ');
    } else if (nums.length >= 2) {
      amtMatch = nums[0];
    }
  }
  const amount = num(amtMatch);
  t = t.replace(amtMatch[0], ' ');
  const name = t.replace(/\b(bill|due|on|the|every|month|monthly|is|for|of|a)\b/gi, ' ').replace(/[^\p{L}\p{N}&' -]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!name || !(amount > 0) || !(day >= 1 && day <= 31)) return null;
  return { name: name.replace(/^\w/, (c) => c.toUpperCase()), amount: r2(amount), day };
}

// "Groceries 400" — monthly essential
export function parseEssential(text) {
  const amount = parseAmount(text);
  const name = String(text).replace(AMOUNT, ' ').replace(/\b(a|per|every|month|monthly|\/mo|mo)\b/gi, ' ').replace(/[^\p{L}\p{N}&' -]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!name || !(amount > 0)) return null;
  return { name: name.replace(/^\w/, (c) => c.toUpperCase()), monthly: r2(amount) };
}

// ── the paycheque sort ────────────────────────────────────────
// 1) bills: each bill gets its share so it's fully funded by its due date — bills due
//    before the next payday get everything they still need. Earliest due first.
// 2) essentials: monthly total ÷ paycheques per month.
// 3) the rest splits into spending / leisure / investing by your percentages.
export function allocate(b, amount, on = today()) {
  const interval = PAY_DAYS[b.pay.freq] || 14;
  const nextPay = addDays(on, Math.round(interval));
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
  const short = r2(bills.reduce((s, x) => s + (x.want - x.give), 0) + (essWant - essentials));
  return { amount: r2(amount), on, nextPay, bills, essentials, essWant, spending, leisure, investing, short: short > 0.005 ? short : 0 };
}

export function applyPaycheque(b, a) {
  for (const x of a.bills) {
    const bill = b.bills.find((y) => y.id === x.id);
    if (bill) bill.saved = r2((bill.saved || 0) + x.give);
  }
  b.balances.essentials = r2(b.balances.essentials + a.essentials);
  for (const k of Object.keys(BUCKETS)) b.balances[k] = r2(b.balances[k] + a[k]);
  b.pay.last = a.on;
  b.history.unshift({ on: a.on, amount: a.amount, bills: a.bills.map((x) => ({ name: x.name, give: x.give })), essentials: a.essentials, spending: a.spending, leisure: a.leisure, investing: a.investing, short: a.short });
  b.history = b.history.slice(0, 30);
}

// Bills whose due date passed: paid from their set-aside money, rolled to next month
export function rollBills(b, on = today()) {
  const paid = [];
  for (const bill of b.bills) {
    while (bill.nextDue && bill.nextDue < on) {
      const covered = Math.min(bill.saved || 0, bill.amount);
      paid.push({ name: bill.name, amount: bill.amount, due: bill.nextDue, covered: r2(covered), short: r2(bill.amount - covered) });
      bill.saved = r2((bill.saved || 0) - covered);
      bill.nextDue = nextDue(bill.day, addDays(bill.nextDue, 1));
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
  const b = (await env.PAPER.get('budget', 'json')) || freshBudget();
  return b;
}
export const saveBudget = (env, b) => env.PAPER.put('budget', JSON.stringify(b));

// ── screens (every one starts "BUDGET ·" so taps edit in place) ──
const btn = (text, data) => ({ text, callback_data: data });
const HOME = [btn('💰 Budget home', 'bg')];

export function homeScreen(b, on = today()) {
  const L = ['BUDGET · 💰 BUDGET', ''];
  const set = b.bills.reduce((s, x) => s + (x.saved || 0), 0);
  const due30 = b.bills.filter((x) => daysBetween(on, x.nextDue) <= 30);
  L.push(`Paid ${PAY_NAMES[b.pay.freq]}${b.pay.last ? ` · last payday ${nice(b.pay.last)} · next ≈ ${nice(addDays(b.pay.last, Math.round(PAY_DAYS[b.pay.freq])))}` : ''}`);
  L.push('');
  L.push(`🧾 Set aside for bills: ${money(set)}`);
  L.push(`🛒 Essentials: ${money(b.balances.essentials)}`);
  for (const [k, label] of Object.entries(BUCKETS)) L.push(`${label}: ${money(b.balances[k])}`);
  const since = b.pay.last || '0000';
  const spent = (b.spends || []).filter((e) => e.on >= since).reduce((s2, e) => s2 + e.amount, 0);
  if (spent) L.push(`💸 Spent since last payday: ${money(spent)}`);
  if (b.bills.length) {
    L.push('', 'NEXT BILLS');
    for (const x of [...b.bills].sort((p, q) => (p.nextDue < q.nextDue ? -1 : 1)).slice(0, 6)) {
      const d = daysBetween(on, x.nextDue);
      L.push(`${(x.saved || 0) >= x.amount ? '✅' : d <= 7 ? '⚠️' : '◻️'} ${x.name} ${money(x.amount)} — ${nice(x.nextDue)}${d === 0 ? ' (today)' : d === 1 ? ' (tomorrow)' : ` (${d}d)`} · ${money(x.saved || 0)} set aside`);
    }
  } else {
    L.push('', 'No bills yet — tap ➕ Add bill.');
  }
  if (!due30.length && b.bills.length) L.push('Nothing due in the next 30 days.');
  return {
    text: L.join('\n'),
    kb: [
      [btn('💵 I got paid', 'bgp'), btn('💸 Log spending', 'bgw')],
      [btn('➕ Add bill', 'bga')],
      [btn('🧾 Bills', 'bgb'), btn('🛒 Essentials', 'bge')],
      [btn('⚖️ Split %', 'bgs'), btn('📅 Pay schedule', 'bgf')],
      [btn('📜 History', 'bgh'), btn('🔄', 'bg')],
    ],
  };
}

export function paidScreen(b, a) {
  const L = [`BUDGET · 💵 PAYCHEQUE ${money(a.amount)} — SORTED`, ''];
  if (a.bills.length) {
    L.push('🧾 BILLS (put aside)');
    for (const x of a.bills) L.push(`• ${x.name}: ${money(x.give)} → due ${nice(x.due)}${x.fullyFunded ? ' ✅ fully covered' : x.give < x.want ? ` ⚠️ short ${money(x.want - x.give)}` : ''}`);
    L.push(`  Total: ${money(a.bills.reduce((s, x) => s + x.give, 0))}`, '');
  }
  L.push(`🛒 ESSENTIALS: ${money(a.essentials)}${a.essentials < a.essWant ? ` (needed ${money(a.essWant)})` : ''}`, '');
  L.push('✨ WHAT\'S LEFT');
  L.push(`${BUCKETS.spending}: ${money(a.spending)}`, `${BUCKETS.leisure}: ${money(a.leisure)}`, `${BUCKETS.investing}: ${money(a.investing)}`);
  if (a.short) L.push('', `⚠️ This paycheque came up ${money(a.short)} short of what bills + essentials need before the next one. Bills were covered first, earliest due first.`);
  L.push('', `Next payday ≈ ${nice(a.nextPay)}`);
  return { text: L.join('\n'), kb: [HOME] };
}

export function billsScreen(b, on = today()) {
  const L = ['BUDGET · 🧾 BILLS (monthly)', ''];
  if (!b.bills.length) L.push('No bills yet.');
  const total = b.bills.reduce((s, x) => s + x.amount, 0);
  for (const x of [...b.bills].sort((p, q) => p.day - q.day)) {
    L.push(`${(x.saved || 0) >= x.amount ? '✅' : '◻️'} ${x.name} — ${money(x.amount)} on the ${ordinal(x.day)} · next ${nice(x.nextDue)} · ${money(x.saved || 0)} set aside`);
  }
  if (b.bills.length) L.push('', `Total bills: ${money(total)} / month`);
  L.push('', 'Tap a bill to remove it or mark it paid early.');
  const kb = [];
  const list = [...b.bills].sort((p, q) => p.day - q.day);
  for (let i = 0; i < list.length; i += 2) kb.push(list.slice(i, i + 2).map((x) => btn(`${x.name} ${money(x.amount)}`, `bgi:${x.id}`)));
  kb.push([btn('➕ Add bill', 'bga'), ...HOME]);
  return { text: L.join('\n'), kb };
}

export function billItemScreen(b, id) {
  const x = b.bills.find((y) => y.id === id);
  if (!x) return billsScreen(b);
  return {
    text: `BUDGET · 🧾 ${x.name}\n\n${money(x.amount)} due on the ${ordinal(x.day)} of every month\nNext: ${nice(x.nextDue)} · ${money(x.saved || 0)} set aside`,
    kb: [[btn('✅ Paid it (this month)', `bgk:${id}`), btn('🗑 Remove', `bgx:${id}`)], [btn('⬅️ Bills', 'bgb'), ...HOME]],
  };
}

export function essentialsScreen(b) {
  const L = ['BUDGET · 🛒 ESSENTIALS (monthly)', 'Groceries, gas, transit, phone top-ups… anything you need every month that isn\'t a fixed bill.', ''];
  if (!b.essentials.length) L.push('None yet.');
  for (const e of b.essentials) L.push(`• ${e.name}: ${money(e.monthly)} / month`);
  const total = b.essentials.reduce((s, e) => s + e.monthly, 0);
  if (b.essentials.length) L.push('', `Total ${money(total)} / month → about ${money(total / (30.44 / PAY_DAYS[b.pay.freq]))} from each paycheque`);
  const kb = [];
  for (let i = 0; i < b.essentials.length; i += 2) kb.push(b.essentials.slice(i, i + 2).map((e) => btn(`🗑 ${e.name}`, `bgy:${e.id}`)));
  kb.push([btn('➕ Add essential', 'bgn'), ...HOME]);
  return { text: L.join('\n'), kb };
}

const SPLITS = [[40, 30, 30], [50, 30, 20], [50, 20, 30], [60, 20, 20], [34, 33, 33], [30, 30, 40]];
export function splitScreen(b) {
  const s = b.split;
  return {
    text: `BUDGET · ⚖️ WHAT'S LEFT GETS SPLIT\n\nAfter bills and essentials, the rest of each paycheque goes:\n${BUCKETS.spending} ${s.spending}% · ${BUCKETS.leisure} ${s.leisure}% · ${BUCKETS.investing} ${s.investing}%\n\nPick a split (spending / leisure / investing):`,
    kb: [
      ...[0, 3].map((i) => SPLITS.slice(i, i + 3).map(([a, c, d]) => btn(`${s.spending === a && s.leisure === c ? '✅ ' : ''}${a}/${c}/${d}`, `bgv:${a}:${c}:${d}`))),
      HOME,
    ],
  };
}

export function payScreen(b) {
  return {
    text: `BUDGET · 📅 HOW OFTEN DO YOU GET PAID?\n\nNow: ${PAY_NAMES[b.pay.freq]}. This sets how much each paycheque puts aside for bills and essentials.`,
    kb: [
      Object.keys(PAY_NAMES).slice(0, 2).map((k) => btn(`${b.pay.freq === k ? '✅ ' : ''}${PAY_NAMES[k]}`, `bgq:${k}`)),
      Object.keys(PAY_NAMES).slice(2).map((k) => btn(`${b.pay.freq === k ? '✅ ' : ''}${PAY_NAMES[k]}`, `bgq:${k}`)),
      HOME,
    ],
  };
}

export function historyScreen(b) {
  const L = ['BUDGET · 📜 HISTORY', ''];
  if (!b.history.length && !b.log.length) L.push('Nothing yet.');
  for (const h of b.history.slice(0, 8)) L.push(`💵 ${nice(h.on)} — ${money(h.amount)}: bills ${money(h.bills.reduce((s, x) => s + x.give, 0))} · essentials ${money(h.essentials)} · spend ${money(h.spending)} · leisure ${money(h.leisure)} · invest ${money(h.investing)}${h.short ? ` · ⚠️ short ${money(h.short)}` : ''}`);
  if (b.spends?.length) {
    L.push('', 'SPENDING');
    for (const e of b.spends.slice(0, 12)) L.push(`💸 ${nice(e.on)} ${money(e.amount)} · ${ALL_BUCKETS[e.bucket]}${e.note ? ` — ${e.note}` : ''}`);
  }
  if (b.log.length) {
    L.push('', 'BILLS PAID');
    for (const p of b.log.slice(0, 8)) L.push(`🧾 ${nice(p.due)} ${p.name} ${money(p.amount)}${p.short ? ` — ⚠️ ${money(p.short)} wasn't set aside` : ' ✅'}`);
  }
  return { text: L.join('\n'), kb: [HOME] };
}

// ── spending: "40 leisure drinks" · "/spent 85 groceries" ─────────
const ALL_BUCKETS = { essentials: '🛒 Essentials', ...BUCKETS };
const BUCKET_WORDS = [
  ['essentials', /essential|grocer|food|gas\b|fuel|transit|uber|bus|pharmac|household|toiletr|laundry/i],
  ['leisure', /leisure|fun|bar|drink|beer|restaurant|dinner|movie|concert|game|trip|travel|date|party/i],
  ['investing', /invest|stock|crypto|etf|tfsa|rrsp|savings|save/i],
  ['spending', /spend|shop|clothes|amazon|misc|other/i],
];
export function parseSpend(text, bucket = null) {
  const amount = parseAmount(text);
  if (!(amount > 0)) return null;
  let b = bucket;
  if (!b) for (const [k, re] of BUCKET_WORDS) if (re.test(text)) { b = k; break; }
  const note = String(text).replace(AMOUNT, ' ').replace(/\b(essentials?|spending|leisure|investing|invest|on|for|at|spent)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return { amount: r2(amount), bucket: b || 'spending', note: note.slice(0, 40) };
}

export function logSpend(b, sp, on = today()) {
  b.spends ||= [];
  b.balances[sp.bucket] = r2((b.balances[sp.bucket] || 0) - sp.amount);
  const entry = { id: b.nextId++, on, ...sp };
  b.spends.unshift(entry);
  b.spends = b.spends.slice(0, 100);
  return entry;
}

export function spentScreen(b, e) {
  const left = b.balances[e.bucket];
  return {
    text: `BUDGET · 💸 Logged ${money(e.amount)} from ${ALL_BUCKETS[e.bucket]}${e.note ? ` — ${e.note}` : ''}\n\n${ALL_BUCKETS[e.bucket]} left: ${money(left)}${left < 0 ? `\n⚠️ That's ${money(-left)} over — it'll come out of the next paycheque's ${e.bucket === 'essentials' ? 'essentials' : 'split'} unless you move money.` : ''}\n\nSend another amount for this bucket, or tap Done.`,
    kb: [[btn('↩️ Undo', `bgu:${e.id}`), btn('✔️ Done', 'bg')]],
  };
}

export function spendPickScreen(b) {
  return {
    text: `BUDGET · 💸 LOG SPENDING — which bucket?\n\n${Object.entries(ALL_BUCKETS).map(([k, l]) => `${l}: ${money(b.balances[k] || 0)} left`).join('\n')}\n\nOr just type it, e.g. "40 drinks" or "85 groceries" — I'll pick the bucket.`,
    kb: [
      [btn(ALL_BUCKETS.essentials, 'bgw:essentials'), btn(ALL_BUCKETS.spending, 'bgw:spending')],
      [btn(ALL_BUCKETS.leisure, 'bgw:leisure'), btn(ALL_BUCKETS.investing, 'bgw:investing')],
      HOME,
    ],
  };
}

export const ASK = {
  pay: 'BUDGET · 💵 How much did you get paid? Send the amount, e.g. 1850 or $1,850.25',
  bill: 'BUDGET · ➕ Send the bill like:\nRent 1200 on the 1st\nPhone $85.50 15th\nCar insurance 210 due 28',
  essential: 'BUDGET · ➕ Send a monthly essential like:\nGroceries 400\nGas 160',
  spend: (k) => `BUDGET · 💸 How much from ${ALL_BUCKETS[k]}? (${'e.g.'} 40 or "40 coffee")`,
};

// Handle a typed reply while the assistant is waiting for one. Returns a screen, or null if not handled.
export function handleText(b, text, on = today()) {
  const t = String(text).trim();
  const kind = b.awaiting;
  if (!kind) return null;
  if (/^(cancel|stop|nevermind|never mind)$/i.test(t)) {
    b.awaiting = null;
    return homeScreen(b, on);
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
    const p = parseBill(t);
    if (!p) return { text: `${ASK.bill}\n\n(Couldn't read a name, amount and day in "${t}")`, kb: [HOME] };
    b.awaiting = 'bill'; // stay ready for the next one
    b.bills.push({ id: b.nextId++, ...p, nextDue: nextDue(p.day, on), saved: 0 });
    return { text: `BUDGET · ✅ Added ${p.name} — ${money(p.amount)} on the ${ordinal(p.day)} (next ${nice(nextDue(p.day, on))}).\n\nSend another bill, or tap Done.`, kb: [[btn('✔️ Done', 'bgb')]] };
  }
  if (kind === 'spend' || kind.startsWith('spend:')) {
    const sp = parseSpend(t, kind.includes(':') ? kind.split(':')[1] : null);
    if (!sp) return { text: `BUDGET · 💸 Couldn't read an amount in "${t}". Send e.g. 40 or "40 drinks".`, kb: [HOME] };
    return spentScreen(b, logSpend(b, sp, on)); // stays listening on this bucket
  }
  if (kind === 'essential') {
    const p = parseEssential(t);
    if (!p) return { text: `${ASK.essential}\n\n(Couldn't read "${t}")`, kb: [HOME] };
    b.essentials.push({ id: b.nextId++, ...p });
    return { text: `BUDGET · ✅ Added ${p.name} — ${money(p.monthly)} / month.\n\nSend another, or tap Done.`, kb: [[btn('✔️ Done', 'bge')]] };
  }
  return null;
}

// Button taps (ops start with "bg")
export function handleTap(b, op, a, c, d, on = today()) {
  rollBills(b, on);
  if (op === 'bg') {
    b.awaiting = null; // Done / home stops listening for typed replies
    return homeScreen(b, on);
  }
  if (op === 'bgp') { b.awaiting = 'pay'; return { text: ASK.pay, kb: [HOME] }; }
  if (op === 'bga') { b.awaiting = 'bill'; return { text: ASK.bill, kb: [HOME] }; }
  if (op === 'bgn') { b.awaiting = 'essential'; return { text: ASK.essential, kb: [HOME] }; }
  if (op === 'bgw') {
    b.awaiting = a ? `spend:${a}` : 'spend';
    return a ? { text: ASK.spend(a), kb: [HOME] } : spendPickScreen(b);
  }
  b.awaiting = null;
  if (op === 'bgu') {
    const e = (b.spends || []).find((x) => x.id === Number(a));
    if (e) {
      b.balances[e.bucket] = r2((b.balances[e.bucket] || 0) + e.amount);
      b.spends = b.spends.filter((x) => x.id !== e.id);
    }
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
      x.nextDue = nextDue(x.day, addDays(x.nextDue, 1));
    }
    return billsScreen(b, on);
  }
  if (op === 'bge') return essentialsScreen(b);
  if (op === 'bgy') {
    b.essentials = b.essentials.filter((e) => e.id !== Number(a));
    return essentialsScreen(b);
  }
  if (op === 'bgs') return splitScreen(b);
  if (op === 'bgv') {
    b.split = { spending: Number(a), leisure: Number(c), investing: Number(d) };
    return splitScreen(b);
  }
  if (op === 'bgf') return payScreen(b);
  if (op === 'bgq') {
    if (PAY_NAMES[a]) b.pay.freq = a;
    return payScreen(b);
  }
  if (op === 'bgh') return historyScreen(b);
  return homeScreen(b, on);
}

// Daily (9 AM Toronto): roll paid bills, remind about bills due today / in 3 days
export function dailyReminders(b, on = today()) {
  const paid = rollBills(b, on);
  const msgs = paid.map((p) => `🧾 ${p.name} ${money(p.amount)} was due ${nice(p.due)} — ${p.short ? `⚠️ only ${money(p.covered)} was set aside` : 'paid from what you set aside ✅'}`);
  for (const x of b.bills) {
    const d = daysBetween(on, x.nextDue);
    if (d === 0 || d === 3) {
      const ready = (x.saved || 0) >= x.amount;
      msgs.push(`⏰ ${x.name} ${money(x.amount)} is due ${d === 0 ? 'TODAY' : `in 3 days (${nice(x.nextDue)})`} — ${ready ? 'fully set aside ✅' : `${money(x.saved || 0)} set aside, ${money(x.amount - (x.saved || 0))} still needed ⚠️`}`);
    }
  }
  return msgs;
}
