"""ETF analysis from what free data supports: total vs price return (shows how much return came from distributions),
distribution yield and its stability, volatility, drawdown and trend. Fees, AUM, flows and holdings are not available
for free, so those parts of the ETF profile are marked missing (and never earn points)."""
from __future__ import annotations

from .base import Component, pct
from .dividend import ttm_yield


def analyze(bars: list[dict], dividends: list[dict], px: dict) -> dict:
    if len(bars) < 252:
        return {"available": False}
    tr = bars[-1]["adj"] / bars[-252]["adj"] - 1
    pr = bars[-1]["c"] / bars[-252]["c"] - 1
    dy = ttm_yield(dividends, bars[-1]["c"])
    return {
        "available": True, "total_return_1y": tr, "price_return_1y": pr, "distribution_share": (tr - pr) if tr is not None else None,
        "yield": dy.get("yield"), "dividend": dy, "vol_1y": px.get("vol_1y"), "max_dd_1y": px.get("max_dd_1y"),
        "ret_3m": px.get("ret_3m"), "above_ma200": px.get("above_ma200"),
        "nav_erosion": pr < -0.05 and (dy.get("yield") or 0) > 0.07,
    }


def score(a: dict, label: str) -> tuple[float, list[dict], float]:
    """Returns (score 0-100, components, confidence) for the ETF profile."""
    comps = []
    q = Component("portfolio_quality")
    q.miss("holdings, concentration and NAV (no free holdings feed)")
    comps.append((q, 30))
    f = Component("flows_and_fees")
    f.miss("fund flows, AUM and expense ratio (no free feed)")
    comps.append((f, 20))
    r = Component("return_quality")
    if not a.get("available"):
        r.miss("one year of price history")
    else:
        tr = a["total_return_1y"]
        if tr > 0.15:
            r.add(0.5, f"total return {pct(tr)} over 1 year")
        elif tr > 0.05:
            r.add(0.3, f"total return {pct(tr)} over 1 year")
        else:
            r.no(f"total return {pct(tr)} over 1 year")
        if a.get("above_ma200"):
            r.add(0.2, "above its 200-day average")
        if (a.get("max_dd_1y") or 1) < 0.15:
            r.add(0.3, f"max drawdown {pct(a['max_dd_1y'])} in a year")
        if a.get("nav_erosion"):
            r.no("price falling while paying a high distribution — possible return of capital / NAV erosion")
            r.earned -= 0.3
    comps.append((r.clamp(), 30))
    inc = Component("income")
    y = a.get("yield")
    if y is None:
        inc.miss("distribution yield")
    else:
        inc.add(0.5 if y > 0.02 else 0.2, f"distribution yield {pct(y, 1)}")
        if not (a.get("dividend") or {}).get("cuts"):
            inc.add(0.3, "no distribution cuts on record")
        if y > 0.1:
            inc.no("yield above 10% — check how much is return of capital")
            inc.earned = min(inc.earned, 0.3)
    comps.append((inc.clamp(), 20))
    total = sum(cmp.earned * w for cmp, w in comps)
    conf = 35 if a.get("available") else 10  # half the profile has no data
    return round(total, 1), [cmp.to_dict(w) for cmp, w in comps], conf
