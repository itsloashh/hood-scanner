"""Dividend engine. Yield comes from distributions paid in the last 12 months (ex-dates within 365 days),
split-adjusted, divided by today's price. Stale or one-off data never produces a yield."""
from __future__ import annotations

from datetime import date, timedelta

from .. import config
from .base import Component, pct


def ttm_yield(dividends: list[dict], price: float | None, as_of: str | None = None, stale_days: int = 400) -> dict:
    """dividends: [{ex_date, amount}] already split-adjusted (Yahoo adjusts them). Returns yield + checks."""
    today = date.fromisoformat(as_of) if as_of else date.today()
    if not dividends or not price:
        return {"yield": None, "why": "no distributions on record" if not dividends else "no price"}
    last = max(d["ex_date"] for d in dividends)
    if (today - date.fromisoformat(last)).days > stale_days:
        return {"yield": None, "why": f"last distribution {last} — stale, not counted", "last_ex": last}
    start = (today - timedelta(days=365)).isoformat()
    paid = [d for d in dividends if start < d["ex_date"] <= today.isoformat() and d.get("amount")]
    total = sum(d["amount"] for d in paid)
    years = sorted({d["ex_date"][:4] for d in dividends})
    per_year = {}
    for d in dividends:
        per_year[d["ex_date"][:4]] = per_year.get(d["ex_date"][:4], 0) + (d.get("amount") or 0)
    full_years = [y for y in years if y < str(today.year)]
    cuts = [y for i, y in enumerate(full_years[1:], 1) if per_year[y] < per_year[full_years[i - 1]] * 0.9]
    freq = len(paid)
    growth5 = None
    if len(full_years) >= 6 and per_year[full_years[-6]] > 0:
        growth5 = (per_year[full_years[-1]] / per_year[full_years[-6]]) ** (1 / 5) - 1
    return {
        "yield": total / price if total else None, "ttm_amount": total, "payments_12m": freq, "last_ex": last,
        "years_paid": len(full_years), "cuts": cuts, "growth_5y": growth5, "per_year": per_year,
    }


def score(m: dict, dy: dict, model: str) -> Component:
    c = Component("income_quality")
    y = dy.get("yield")
    if y is None:
        c.miss(f"dividend yield ({dy.get('why', 'not available')})")
        return c
    D = config.DIVIDEND
    if y >= D["investigate_above"]:
        c.no(f"yield {pct(y, 1)} is above 10% — mandatory investigation, no points until verified")
        return c
    if D["yield_min"] <= y <= D["yield_max"]:
        c.add(0.25, f"yield {pct(y, 1)} within 2.5–8%")
    else:
        c.no(f"yield {pct(y, 1)} outside 2.5–8%")
    if dy.get("years_paid", 0) >= D["min_years"]:
        c.add(0.15, f"{dy['years_paid']} years of distributions")
    else:
        c.no(f"only {dy.get('years_paid', 0)} full years of distributions")
    if dy.get("cuts"):
        c.no(f"cut in {', '.join(dy['cuts'][-3:])}")
    else:
        c.add(0.1, "no cuts on record")
    if dy.get("growth_5y") is not None and dy["growth_5y"] > 0.03:
        c.add(0.1, f"distributions grew {pct(dy['growth_5y'], 1)}/yr over 5 years")
    if model == "reit":
        p = m.get("ffo_payout")
        if p is None:
            c.miss("FFO payout")
        elif p <= 0.9:
            c.add(0.25, f"FFO payout {pct(p)} (≤ 90%, approx. FFO)")
        else:
            c.no(f"FFO payout {pct(p)}")
    elif model in ("bank", "insurance", "financial"):
        p = m.get("earnings_payout")
        if p is None:
            c.miss("earnings payout")
        elif p <= 0.6:
            c.add(0.25, f"earnings payout {pct(p)} (≤ 60% for financials)")
        else:
            c.no(f"earnings payout {pct(p)}")
    else:
        fp, ep = m.get("fcf_payout"), m.get("earnings_payout")
        if fp is None and ep is None:
            c.miss("payout ratio (cash dividends paid not reported)")
        if fp is not None:
            if fp <= 0.75:
                c.add(0.2, f"FCF covers the dividend ({pct(fp)} payout)")
            else:
                c.no(f"FCF payout {pct(fp)} (> 75%)")
        if ep is not None and ep <= config.DIVIDEND["max_payout"]:
            c.add(0.1, f"earnings payout {pct(ep)}")
        if (m.get("net_debt_ebitda") or 0) > 3.5:
            c.no(f"net debt/EBITDA {m['net_debt_ebitda']:.1f} — leverage pressures the dividend")
    return c.clamp()
