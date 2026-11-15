"""Insider engine (Form 4). Open-market purchases by officers and directors carry the weight;
awards, option exercises, tax withholding and 10b5-1 plan trades don't. Sales are not read as bearish by default."""
from __future__ import annotations

from datetime import date, timedelta

from .base import Component

SENIOR = ("chief executive", "ceo", "chief financial", "cfo", "president", "chair")


def is_senior(owner: dict) -> bool:
    t = (owner.get("title") or "").lower()
    return any(s in t for s in SENIOR)


def summarize(filings: list[dict], as_of: str | None = None) -> dict:
    """filings: parsed Form 4s for one issuer: {owners, transactions, filed, url}."""
    today = date.fromisoformat(as_of) if as_of else date.today()
    out = {"buys": [], "sells_value_90d": 0.0, "buys_value_90d": 0.0, "other": 0}
    for f in filings:
        owners = f.get("owners") or []
        who = owners[0] if owners else {}
        role = who.get("title") or ("Director" if who.get("isDirector") else "10% owner" if who.get("isTenPercentOwner") else "Insider")
        for tx in f.get("transactions") or []:
            if not tx.get("date"):
                continue
            age = (today - date.fromisoformat(tx["date"][:10])).days
            if age > 90 or age < 0:
                continue
            if tx["type"] == "open_market_purchase" and not tx.get("plan_10b5_1") and (tx.get("value") or 0) > 0:
                out["buys"].append({"insider": who.get("name"), "role": role, "senior": is_senior(who), "officer": who.get("isOfficer"),
                                    "director": who.get("isDirector"), "date": tx["date"], "filed": f.get("filed"), "shares": tx["shares"],
                                    "price": tx["price"], "value": tx["value"], "owned_after": tx.get("owned_after"), "url": f.get("url")})
                out["buys_value_90d"] += tx["value"]
            elif tx["type"] == "open_market_sale":
                out["sells_value_90d"] += tx.get("value") or 0
            else:
                out["other"] += 1
    buys = out["buys"]
    for w in (30, 60, 90):
        cut = (today - timedelta(days=w)).isoformat()
        out[f"buyers_{w}d"] = len({b["insider"] for b in buys if b["date"] >= cut})
    out["senior_buy"] = any(b["senior"] for b in buys)
    return out


def score(ins: dict) -> Component:
    c = Component("insider_strategic")
    if not ins.get("buys"):
        c.no("no open-market insider purchases in 90 days")
    else:
        n30, n90 = ins.get("buyers_30d", 0), ins.get("buyers_90d", 0)
        v = ins["buys_value_90d"]
        if n30 >= 2:
            c.add(0.55, f"{n30} insiders bought on the open market within 30 days")  # Nov 15: was 0.45
        elif n90 >= 2:
            c.add(0.35, f"{n90} insiders bought on the open market within 90 days")
        else:
            c.add(0.2, "an insider bought on the open market")
        if ins.get("senior_buy"):
            c.add(0.35, "CEO/CFO/President/Chair among the buyers")  # Nov 15: was 0.25
        if v >= 1e6:
            c.add(0.2, f"${v / 1e6:.1f}M bought in total")
        elif v >= 2.5e5:  # Nov 15: was $100k
            c.add(0.1, f"${v / 1e3:.0f}k bought in total")
    for a in ins.get("activist", []):
        c.add(0.3, f"{a['form']} (5%+ owner, active intent) filed {a['filed']}")
    return c.clamp()
