"""Opportunity scoring (deterministic, versioned, explainable).

Score = how attractive the thesis looks. Confidence (confidence.py) = how good the evidence is.
They are reported side by side and never blended."""
from __future__ import annotations

from .. import config
from .base import Component, pct


def market_sector(px: dict, sector: str | None, rotation: dict, tilt: dict, sector_px: dict | None = None) -> Component:
    c = Component("market_sector")
    rot = rotation.get(sector or "")
    if not sector:
        c.miss("sector")
    elif not rot:
        c.miss(f"{sector} sector ETF data")
    else:
        if rot["state"] == "leading":
            c.add(0.35, f"{sector} outperforming the S&P 500 over 1 and 3 months")
        elif rot["state"] == "improving":
            c.add(0.25, f"{sector} turning up vs the S&P 500 this month")
        else:
            c.no(f"{sector} is {rot['state']} vs the S&P 500")
        t = tilt.get(sector, 0)
        if t > 0:
            c.add(0.2, f"recent economic data leans positive for {sector}")
        elif t < 0:
            c.no(f"recent economic data leans negative for {sector}")
    # Momentum (Nov 15: more weight on trend and on beating the sector)
    if px.get("above_ma50"):
        c.add(0.25, "price back above its 50-day average")
    if px.get("above_ma200"):
        c.add(0.2, "above its 200-day average")
    if px.get("above_ma50") and px.get("above_ma200"):
        c.add(0.1, "above both the 50- and 200-day averages")
    spx = (sector_px or {}).get(sector or "")
    if spx and px.get("ret_3m") is not None and spx.get("ret_3m") is not None:
        rs3 = px["ret_3m"] - spx["ret_3m"]
        if rs3 >= 0.05:
            c.add(0.2, f"beating its sector ETF by {rs3 * 100:.0f} pts over 3 months")
            if px.get("ret_1m") is not None and spx.get("ret_1m") is not None and px["ret_1m"] > spx["ret_1m"]:
                c.add(0.05, "and still ahead of it this month")
        elif rs3 <= -0.05:
            c.no(f"lagging its sector ETF by {-rs3 * 100:.0f} pts over 3 months")
    if (px.get("rel_volume") or 0) > 1.3:
        c.add(0.1, f"trading volume {px['rel_volume']:.1f}× its 90-day average")
    return c.clamp()


def data_quality(v: dict) -> Component:
    """v: verification facts gathered by the pipeline."""
    c = Component("data_quality")
    if v.get("sec_financials"):
        c.add(0.4, "financials from SEC filings (primary source)")
    else:
        c.no("no verified financial statements")
    age = v.get("filing_age_days")
    if age is not None:
        if age <= 120:
            c.add(0.2, f"latest financial filing {age} days old")
        elif age > 200:
            c.no(f"latest financial filing is {age} days old")
    if v.get("price_fresh"):
        c.add(0.15, "price data current")
    else:
        c.no("price data stale")
    if v.get("mcap_confirmed") is True:
        c.add(0.15, "market cap matches an independent source within 10%")
    elif v.get("mcap_confirmed") is False:
        c.no("market cap disagrees with an independent source")
    if v.get("restated"):
        c.no("a recent period was restated in a later filing")
        c.earned -= 0.1
    else:
        c.add(0.1, "no restatements in the periods used")
    return c.clamp()


def classify(score: float) -> str:
    for th, name in config.CLASSES:
        if score >= th:
            return name
    return config.CLASSES[-1][1]


def combine(components: dict[str, Component], profile: str, *, verified_financials: bool, quarantined: list[str]) -> dict:
    weights = config.PROFILES[profile]
    parts = {k: components[k].to_dict(w) for k, w in weights.items() if k in components}
    total = sum(p["points"] for p in parts.values())
    caps = []
    if not verified_financials and total > config.CAPS["no_verified_financials"]:
        total = config.CAPS["no_verified_financials"]
        caps.append("capped at 69: no verified financial statements")
    core = sum(parts[k]["points"] for k in ("financial_health", "valuation", "growth_catalysts", "income_quality") if k in parts)
    if core < 20 and total > config.CAPS["institutional_only"]:
        total = config.CAPS["institutional_only"]
        caps.append(f"capped at {config.CAPS['institutional_only']}: the case rests mostly on institutional buying")
    if quarantined:
        caps.append("quarantined: " + "; ".join(quarantined))
        total = min(total, 39)
    total = round(total, 1)
    return {"profile": profile, "score": total, "class": classify(total), "components": parts, "caps": caps, "version": config.SCORE_VERSION}


def choose_profiles(m: dict, dy: dict) -> list[str]:
    """Which strategy lenses apply. Growth companies are never judged on dividends; non-payers skip the dividend lens."""
    out = ["value"]
    if (m.get("rev_growth") or 0) >= 0.08:
        out.append("growth")
    if (dy.get("yield") or 0) >= 0.015:
        out.append("dividend")
    return out


def why_flagged(best: dict) -> list[str]:
    reasons = []
    for k in sorted(best["components"], key=lambda k: -best["components"][k]["points"]):
        reasons += best["components"][k]["reasons"][:2]
    return [r for r in reasons if "not a live trade" not in r][:5]


__all__ = ["market_sector", "data_quality", "combine", "choose_profiles", "classify", "why_flagged", "Component", "pct"]
