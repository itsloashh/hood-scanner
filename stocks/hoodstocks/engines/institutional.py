"""Institutional engine: quarter-over-quarter 13F comparison for tracked managers, plus 13D/13G ownership filings.

13F is a historical disclosure: it shows what a manager held on the quarter-end date, filed up to 45 days later.
Nothing here is ever described as a live purchase."""
from __future__ import annotations

from .base import Component


def compare(prev: list[dict], cur: list[dict], *, split_factor=lambda cusip: 1.0) -> list[dict]:
    """prev/cur: aggregated holdings {cusip: {shares, value_usd, issuer}}. Shares in `prev` are multiplied by the split
    factor between the two period ends so a 2-for-1 split doesn't look like a doubled position."""
    p = {h["cusip"]: h for h in prev}
    c = {h["cusip"]: h for h in cur}
    tot_p = sum(h.get("value_usd") or 0 for h in prev) or 1
    tot_c = sum(h.get("value_usd") or 0 for h in cur) or 1
    out = []
    for cusip in set(p) | set(c):
        a, b = p.get(cusip), c.get(cusip)
        f = split_factor(cusip)
        sa = (a["shares"] or 0) * f if a else 0
        sb = (b["shares"] or 0) if b else 0
        if a and not b:
            kind = "exit"
        elif b and not a:
            kind = "new"
        elif sb > sa * 1.05:
            kind = "increase"
        elif sb < sa * 0.95:
            kind = "decrease"
        else:
            kind = "unchanged"
        out.append({
            "cusip": cusip, "issuer": (b or a).get("issuer"), "change": kind,
            "shares_prev": sa, "shares": sb, "shares_change": sb - sa, "pct_change": (sb / sa - 1) if sa else None,
            "weight_prev": (a.get("value_usd") or 0) / tot_p if a else 0.0, "weight": (b.get("value_usd") or 0) / tot_c if b else 0.0,
            "split_adjusted": f != 1.0,
        })
    return out


def aggregate(rows: list[dict]) -> list[dict]:
    """A 13F table can list the same CUSIP several times (different managers/discretion). Sum them; skip options."""
    agg: dict[str, dict] = {}
    for r in rows:
        if r.get("put_call") or (r.get("share_type") and r["share_type"] != "SH"):
            continue
        a = agg.setdefault(r["cusip"], {"cusip": r["cusip"], "issuer": r.get("issuer"), "shares": 0.0, "value_usd": 0.0})
        a["shares"] += r.get("shares") or 0
        a["value_usd"] += r.get("value_usd") or 0
    return list(agg.values())


def describe(ch: dict, manager: str, period: str, filed: str) -> str:
    verb = {"new": "reported a new position", "increase": "reported a larger position", "decrease": "reported a smaller position",
            "exit": "no longer reported a position", "unchanged": "reported an unchanged position"}[ch["change"]]
    pc = f" ({ch['pct_change'] * 100:+.0f}% shares)" if ch.get("pct_change") is not None and ch["change"] in ("increase", "decrease") else ""
    return f"{manager} {verb}{pc} as of {period} (13F filed {filed})"


def score(changes: list[dict], holders13: list[dict]) -> Component:
    """changes: this security's 13F changes across tracked managers for the latest period(s)."""
    c = Component("institutional")
    adds = [x for x in changes if x["change"] in ("new", "increase")]
    cuts = [x for x in changes if x["change"] in ("decrease", "exit")]
    managers_adding = {x["manager"] for x in adds}
    if not changes and not holders13:
        c.miss("no tracked manager reports this security (13F covers ~25 tracked managers)")
        return c
    if len(managers_adding) >= 3:
        c.add(0.6, f"{len(managers_adding)} tracked managers added or opened positions")
    elif len(managers_adding) == 2:
        c.add(0.45, "2 tracked managers added or opened positions")
    elif len(managers_adding) == 1:
        c.add(0.25, f"{next(iter(managers_adding))} added or opened a position")
    news = [x for x in adds if x["change"] == "new"]
    if news:
        c.add(0.15, f"{len(news)} new position(s) among tracked managers")
    if len({x['manager'] for x in cuts}) > len(managers_adding):
        c.no(f"{len({x['manager'] for x in cuts})} tracked managers reduced or exited")
        c.earned -= 0.15
    for h in holders13:
        if h["form"].startswith(("SC 13D", "SCHEDULE 13D")):
            c.add(0.25, f"{h['form']} filed {h['filed']}: a holder crossed 5% with possible active intent")
        else:
            c.add(0.1, f"{h['form']} filed {h['filed']}: passive 5%+ holder")
    c.reasons.append("13F data is quarterly and delayed up to 45 days — it is not a live trade")
    return c.clamp()
