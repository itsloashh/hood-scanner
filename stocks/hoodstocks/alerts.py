"""Alert management: decide, deduplicate, format and deliver Telegram alerts. No calculations happen here —
everything shown comes from engine outputs. Each alert has a stable deduplication key."""
from __future__ import annotations

import html
from datetime import date, timedelta

from . import config, store
from .providers.telegram import send

DASH = "https://hood-desk.vercel.app/stocks"


def _e(x) -> str:
    return html.escape(str(x)) if x is not None else "—"


def money(x, cur="USD"):
    if x is None:
        return "—"
    sym = "C$" if cur == "CAD" else "$"
    a = abs(x)
    if a >= 1e12:
        return f"{sym}{x / 1e12:.2f}T"
    if a >= 1e9:
        return f"{sym}{x / 1e9:.2f}B"
    if a >= 1e6:
        return f"{sym}{x / 1e6:.1f}M"
    if a >= 1e3:
        return f"{sym}{x / 1e3:.0f}k"
    return f"{sym}{x:,.2f}"


def pct(x, d=0):
    return "—" if x is None else f"{x * 100:.{d}f}%"


class Alerts:
    def __init__(self, http, dry: bool = False):
        self.http = http
        self.dry = dry
        self.db = store.read("alerts.json", {"sent": {}, "log": []}) or {"sent": {}, "log": []}
        self.count = 0

    def seen(self, key: str) -> bool:
        return key in self.db["sent"]

    def deliver(self, key: str, kind: str, sid: str | None, text: str, score=None, trigger=None) -> bool:
        if self.seen(key) or self.count >= config.ALERT["max_alerts_per_run"]:
            return False
        ok = True if self.dry else send(self.http, text)
        rec = {"alert_id": f"{kind}:{key}", "security_id": sid, "alert_type": kind, "trigger_event": trigger, "score": score,
               "deduplication_key": key, "created_at": store.now_iso(), "delivery_status": "sent" if ok else "failed"}
        if ok:
            self.db["sent"][key] = rec["created_at"]
            self.count += 1
        self.db["log"] = (self.db["log"] + [rec])[-500:]
        return ok

    def save(self):
        cut = (date.today() - timedelta(days=400)).isoformat()
        self.db["sent"] = {k: v for k, v in self.db["sent"].items() if v >= cut}
        store.write("alerts.json", self.db)

    # ── Opportunity ───────────────────────────────────
    def opportunity(self, d: dict, prev_best: dict | None) -> bool:
        r = d["row"]
        if r["experimental"] or r["quarantined"] or r["score"] < config.ALERT["opportunity_min_score"] or r["confidence"] < config.ALERT["opportunity_min_confidence"]:
            return False
        # a repeat needs a class upgrade AND +10 points over the last alerted score (score changes alone don't re-alert)
        key = f"opp:{r['id']}:{r['class']}"
        if prev_best and (r["score"] - prev_best.get("score", 0) < config.ALERT["rescore_jump"]):
            return False
        return self.deliver(key, "opportunity", r["id"], opportunity_text(d), score=r["score"], trigger=f"score {r['score']} ({r['class']})")

    def insider(self, sid: str, row: dict, ins: dict, filing_key: str) -> bool:
        buys = ins.get("buys", [])
        if not buys:
            return False
        total = sum(b["value"] for b in buys if b["date"] >= (date.today() - timedelta(days=30)).isoformat())
        cluster = ins.get("buyers_30d", 0) >= config.ALERT["insider_cluster_min_people"]
        senior = any(b["senior"] and b["value"] >= config.ALERT["insider_min_value_usd"] for b in buys)
        if not ((cluster and total >= config.ALERT["insider_min_value_usd"]) or senior):
            return False
        lines = [f"<b>INSIDER BUYING</b> · ${_e(row['ticker'])} — {_e(row['name'])}", ""]
        for b in sorted(buys, key=lambda b: b["date"], reverse=True)[:5]:
            lines.append(f"• {_e(b['insider'])} ({_e(b['role'])}) bought {b['shares']:,.0f} sh @ ${b['price']:,.2f} = {money(b['value'])} on {b['date']} (filed {b['filed']})")
        lines += ["", f"Open-market purchases, not plan trades or awards. {ins.get('buyers_30d', 0)} buyer(s) in 30 days.",
                  f"Score {row.get('score', '—')} · confidence {row.get('confidence', '—')} · risk {row.get('risk', '—')}",
                  f"Source: SEC Form 4 · {_e(buys[0].get('url'))}", "", "<i>Research signal — not a buy instruction.</i>"]
        return self.deliver(f"ins:{sid}:{filing_key}", "insider", sid, "\n".join(lines), score=row.get("score"), trigger="Form 4 open-market purchase")

    def institutional(self, sid: str, row: dict, changes: list[dict]) -> bool:
        fresh = (date.today() - timedelta(days=14)).isoformat()
        adds = [c for c in changes if c["change"] in ("new", "increase") and c.get("filed", "") >= fresh]  # only newly filed 13Fs
        managers = {c["manager"] for c in adds}
        if len(managers) < 2:
            return False
        period = max(c["period"] for c in adds)
        lines = [f"<b>INSTITUTIONAL ACCUMULATION</b> · ${_e(row['ticker'])} — {_e(row['name'])}", ""]
        lines += [f"• {_e(c['text'])}" for c in adds[:6]]
        lines += ["", "13F filings are quarter-end snapshots filed up to 45 days later — not live trades.",
                  f"Score {row.get('score')} · confidence {row.get('confidence')}", "", "<i>Research signal — not a buy instruction.</i>"]
        return self.deliver(f"inst:{sid}:{period}", "institutional", sid, "\n".join(lines), score=row.get("score"), trigger=f"13F period {period}")

    def option(self, st: dict) -> bool:
        key = f"optn:{st['ticker']}:{st['expiry']}"
        recent = [k for k, v in self.db["sent"].items() if k.startswith(f"optn:{st['ticker']}:") and v >= (date.today() - timedelta(days=14)).isoformat()]
        if recent:
            return False
        return self.deliver(key, "option", st["id"], option_text(st), score=st["points"], trigger=f"Tier {st['tier']} {st['recommended']} exp {st['expiry']}")

    def catalyst(self, sid: str, row: dict, ev: dict, risk: bool = False) -> bool:
        kind = "risk" if risk else "catalyst"
        title = "RISK ALERT" if risk else "CATALYST"
        text = "\n".join([f"<b>{title}</b> · ${_e(row['ticker'])} — {_e(row['name'])}", "",
                          f"8-K item {ev['item']}: {_e(ev['text'])}", f"Filed {ev['filed']} · {_e(ev['url'])}", "",
                          f"Score {row.get('score')} · confidence {row.get('confidence')} · risk {row.get('risk')}",
                          "Details are in the filing; nothing here is inferred beyond the item type."])
        return self.deliver(f"{kind}:{sid}:{ev['item']}:{ev['filed']}", kind, sid, text, score=row.get("score"), trigger=f"8-K {ev['item']}")


def opportunity_text(d: dict) -> str:
    r, m, sc, risk = d["row"], d["metrics"], d["scenarios"], d["risk"]
    cur = r["currency"]
    L = ["<b>POTENTIAL INVESTMENT OPPORTUNITY</b>", "",
         f"<b>{_e(r['name'])}</b> · ${_e(r['ticker'])} · {_e(r['exchange'])} · {r['country']}",
         f"{r['cap']} cap {r['profile']} · {_e(r['sector'])}",
         f"Price {money(r['price'], cur)} ({cur}, delayed, {r['price_date']}) · Mcap {money(r['mcap'])} USD",
         f"Opportunity score <b>{r['score']}</b>/100 ({_e(r['class'])})",
         f"Evidence confidence <b>{r['confidence']}</b>/100 · Risk {r['risk']}", "", "<b>Why it was flagged</b>"]
    L += [f"• {_e(x)}" for x in d["why"][:4]]
    inst = [c for c in d.get("institutional", []) if c["change"] in ("new", "increase")][:2]
    if inst:
        L += ["", "<b>Institutional</b>"] + [f"• {_e(c['text'])}" for c in inst]
    L += ["", "<b>Financials</b> (TTM, SEC filings)",
          f"Revenue {money(m.get('revenue'))} ({pct(m.get('rev_growth'))} y/y) · Net income {money(m.get('net_income'))}",
          f"FCF {money(m.get('fcf'))} · Debt {money(m.get('debt'))} · Cash {money(m.get('cash'))}",
          "", "<b>Valuation</b>",
          f"P/E {fmt(m.get('pe'))} · EV/EBITDA {fmt(m.get('ev_ebitda'))} · FCF yield {pct(m.get('fcf_yield'), 1)}"]
    if risk["review"] or risk["quarantine"]:
        L += ["", "<b>Risk</b>"] + [f"• {_e(x)}" for x in (risk["quarantine"] + risk["review"])[:3]]
    if sc.get("available"):
        L += ["", f"<b>Model range</b> ({_e(sc['method'])}, {sc['horizon']})",
              f"Bear {money(sc['bear'])} · Base {money(sc['base'])} · Bull {money(sc['bull'])} (equity value)",
              f"Base upside {pct(sc['upside_base'])} vs bear downside {pct(sc['downside_bear'])}"]
    else:
        L += ["", f"Valuation range: unavailable ({_e(sc.get('why'))})"]
    L += zone_lines(d.get("zones"), cur)
    L += ["", f"Sources: SEC XBRL filings, Yahoo delayed prices · {DASH}/{r['id']}", "<i>Research candidate — not a buy instruction.</i>"]
    return "\n".join(L)


def zone_lines(z: dict | None, cur: str = "USD") -> list[str]:
    if not z:
        return []
    p0 = z["price"]
    m = lambda x: money(x, cur)  # noqa: E731
    pc = lambda x: f"{(x / p0 - 1) * 100:+.0f}%"  # noqa: E731
    def tp(t):
        rr = f", {t['rr']:.1f}R" if t.get("rr") is not None else ""
        return f"{t['label']} {m(t['price'])} ({pc(t['price'])}{rr})"

    L = ["", "<b>Zones</b> (from price data — speculative)"]
    s = z.get("swing")
    if s:
        L.append(f"Swing: entry {m(s['entry'][0])}–{m(s['entry'][1])} · stop {m(s['stop'])} ({pc(s['stop'])})")
        L.append("Targets: " + " · ".join(tp(t) for t in s["tps"]))
        L.append(f"Hold while above {m(s['hold'][0])}; after TP1 move the stop to entry")
    c = z.get("scalp")
    if c:
        L.append(f"Scalp (1h): entry {m(c['entry'][0])}–{m(c['entry'][1])} · stop {m(c['stop'])} · " + " · ".join(tp(t) for t in c["tps"]))
    return L


def option_text(st: dict) -> str:
    s = st["structures"][st["recommended"]]
    u = st["underlying"]
    legs = " / ".join(f"{'Buy' if l['side'] == 'buy' else 'Sell'} {l['strike']:g}C" for l in s["legs"])
    name = "CALL" if s["kind"] == "call" else "CALL DEBIT SPREAD"
    L = [f"<b>OPTION SETUP · Tier {st['tier']}</b> · ${_e(st['ticker'])} — {_e(st['name'])}", "",
         f"<b>{name}</b> {legs} · exp {st['expiry']} ({st['dte']} days)",
         f"Cost ≈ ${s['debit']:.2f} (${s['cost']:,.0f}/contract, max loss) · mid ${s['debit_mid']:.2f}",
         f"Breakeven at expiry ${s['breakeven']:.2f}" + (f" · max gain ${s['max_gain']:,.0f}" if s.get("max_gain") else ""),
         "", "<b>Plan (underlying)</b>",
         f"Now ${st['spot']:.2f} · entry {u['entry'][0]:.2f}–{u['entry'][1]:.2f} · stop {u['stop']:.2f}",
         f"TP1 {u['tp1']:.2f} → ≈ {'+' if s['profit_tp1'] >= 0 else ''}${s['profit_tp1']:,.0f} · TP2 {u['tp2']:.2f} → ≈ +${s['profit_tp2']:,.0f} · stop → ≈ ${s['loss_at_stop']:,.0f}",
         f"Exit by {st['exit_by']} (21 days left) if neither level hits",
         "", "<b>Why</b>"] + [f"• {_e(x)}" for x in st["why"][:5]]
    if st["against"]:
        L += ["<b>Watch out</b>"] + [f"• {_e(x)}" for x in st["against"][:3]]
    iv = f"IV {st['atm_iv'] * 100:.0f}%" + (f" vs realised {max(x for x in (st['hv20'], st['hv60']) if x) * 100:.0f}%" if (st.get("hv20") or st.get("hv60")) else "")
    L += ["", f"{iv} · expected move ±{st['expected_move'] / st['spot'] * 100:.1f}% by expiry" if st.get("expected_move") else iv,
          f"Delayed Cboe quotes · {DASH.replace('/stocks', '/options')}", "<i>Research setup — not a trade instruction. Size so the max loss is affordable.</i>"]
    return "\n".join(L)


def fmt(x):
    return "—" if x is None else f"{x:.1f}"


def digest_text(dg: dict) -> str:
    L = [f"<b>STOCK DIGEST</b> · {dg['date']}", ""]
    if dg["new"]:
        L.append("<b>New candidates</b>")
        L += [f"• ${_e(r['ticker'])} {r['score']} ({_e(r['class'])}) · conf {r['confidence']} · {r['profile']}" for r in dg["new"][:6]]
    if dg["improved"]:
        L += ["", "<b>Score improvements</b>"] + [f"• ${_e(r['ticker'])} {r['from']} → {r['to']}" for r in dg["improved"][:5]]
    if dg["insiders"]:
        L += ["", "<b>Insider purchases (Form 4)</b>"] + [f"• ${_e(x['ticker'])}: {x['buyers']} buyer(s), {money(x['value'])}" for x in dg["insiders"][:5]]
    if dg["institutional"]:
        L += ["", "<b>New 13F filings</b>"] + [f"• {_e(x)}" for x in dg["institutional"][:4]]
    if dg["catalysts"]:
        L += ["", "<b>Filed catalysts</b>"] + [f"• ${_e(x['ticker'])}: 8-K {x['item']} {_e(x['text'])}" for x in dg["catalysts"][:5]]
    if dg["risks"]:
        L += ["", "<b>Risk developments</b>"] + [f"• ${_e(x['ticker'])}: {_e(x['text'])}" for x in dg["risks"][:4]]
    if dg["macro"]:
        L += ["", "<b>Economy</b>"] + [f"• {_e(x)}" for x in dg["macro"][:4]]
    if dg["watchlist"]:
        L += ["", "<b>Watchlist</b>"] + [f"• {_e(x)}" for x in dg["watchlist"][:5]]
    if dg["warnings"]:
        L += ["", "<b>Data warnings</b>"] + [f"• {_e(x)}" for x in dg["warnings"][:4]]
    if len(L) <= 2:
        L.append("Nothing new today.")
    L += ["", DASH]
    return "\n".join(L)
