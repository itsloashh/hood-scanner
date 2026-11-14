"""Evidence confidence (0–100), independent of the opportunity score."""
from __future__ import annotations

KEY_METRICS = ("revenue", "net_income", "ocf", "cash", "equity", "shares_outstanding", "assets")


def score(snap: dict | None, v: dict) -> dict:
    pts, notes = 0.0, []
    # source reliability (30)
    if v.get("sec_financials"):
        pts += 30
        notes.append("financials from SEC filings (primary)")
    else:
        notes.append("no primary-source financials")
    # completeness (25)
    if snap:
        have = sum(1 for k in KEY_METRICS if snap.get(k))
        pts += 25 * have / len(KEY_METRICS)
        if have < len(KEY_METRICS):
            notes.append(f"{len(KEY_METRICS) - have} of {len(KEY_METRICS)} key statement items missing")
    # freshness (20)
    age = v.get("filing_age_days")
    if age is not None:
        pts += 12 if age <= 120 else 6 if age <= 200 else 0
        if age > 200:
            notes.append(f"latest filing {age} days old")
    pts += 8 if v.get("price_fresh") else 0
    # independent confirmations (15)
    if v.get("mcap_confirmed") is True:
        pts += 8
    elif v.get("mcap_confirmed") is False:
        notes.append("market cap conflicts with an independent source")
    if v.get("price_confirmed") is True:
        pts += 7
    elif v.get("price_confirmed") is False:
        notes.append("price conflicts with an independent source")
    # conflicts / delays (10)
    pts += 10
    if v.get("restated"):
        pts -= 6
        notes.append("restated periods")
    if v.get("insider_unmapped"):
        pts -= 2
    if v.get("institutional_age_days") and v["institutional_age_days"] > 100:
        pts -= 2
        notes.append("institutional data is from an older quarter")
    return {"confidence": round(max(0, min(100, pts))), "notes": notes}
