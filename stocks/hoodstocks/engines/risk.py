"""Risk engine: financial health scoring, hard rejections/quarantine, manual-review flags, risk label,
and bear/base/bull valuation scenarios. Size never sets the risk label by itself."""
from __future__ import annotations

from statistics import median

from ..providers.sec import ITEM_8K, RED_FLAG_ITEMS, REVIEW_ITEMS
from .base import Component, num, pct

FIN = {"bank", "insurance", "financial"}


def health(m: dict, model: str) -> Component:
    c = Component("financial_health")
    if model in FIN:
        c.na += ["EV/EBITDA, net debt/EBITDA, current ratio (deposits and float are the business, not debt)"]
        ni, roe, eta = m.get("net_income"), m.get("roe"), m.get("equity_to_assets")
        if ni is None:
            c.miss("net income")
        elif ni > 0:
            c.add(0.3, "profitable over the last 12 months")
        else:
            c.no("loss-making over the last 12 months")
        if roe is None:
            c.miss("return on equity")
        elif roe >= 0.12:
            c.add(0.3, f"ROE {pct(roe)}")
        elif roe >= 0.08:
            c.add(0.15, f"ROE {pct(roe)}")
        else:
            c.no(f"ROE {pct(roe)}")
        if eta is None:
            c.miss("equity / assets")
        elif eta >= (0.08 if model == "bank" else 0.15):
            c.add(0.25, f"equity is {pct(eta, 1)} of assets")
        else:
            c.no(f"thin capital: equity {pct(eta, 1)} of assets")
        d = m.get("dilution_1y")
        if d is not None and d <= 0.01:
            c.add(0.15, "no meaningful dilution" if d > -0.01 else f"share count down {pct(-d, 1)} (buybacks)")
        return c.clamp()

    fcf = m.get("fcf")
    if fcf is None:
        c.miss("free cash flow")
    elif fcf > 0:
        c.add(0.25, "positive free cash flow")
        fy = m.get("fcf_yield")
        if fy is not None and fy >= 0.05:
            c.add(0.1, f"FCF yield {pct(fy, 1)}")  # Nov 15
    else:
        c.no("negative free cash flow")
    roic = m.get("roic")  # Nov 15: returns on capital count toward health
    if roic is not None:
        if roic >= 0.15:
            c.add(0.15, f"ROIC {pct(roic)}")
        elif roic >= 0.10:
            c.add(0.08, f"ROIC {pct(roic)}")
        elif roic < 0.05:
            c.no(f"ROIC only {pct(roic)}")
    ni = m.get("net_income")
    if ni is None:
        c.miss("net income")
    elif ni > 0:
        c.add(0.15, "profitable over the last 12 months")
    else:
        c.no("loss-making")
    lev = m.get("net_debt_ebitda")
    if m.get("net_debt") is not None and m["net_debt"] <= 0:
        c.add(0.2, "net cash on the balance sheet")
    elif lev is None:
        c.miss("net debt / EBITDA")
    elif lev <= (4.5 if model in ("reit", "utility") else 2.5):
        c.add(0.2, f"net debt/EBITDA {num(lev)}")
    else:
        c.no(f"net debt/EBITDA {num(lev)}")
    ic = m.get("interest_coverage")
    if ic is not None:
        if ic >= 5:
            c.add(0.15, f"interest covered {num(ic)}× by operating income")
        elif ic < 2:
            c.no(f"interest coverage only {num(ic)}×")
    cr = m.get("current_ratio")
    if cr is not None and model not in ("utility", "reit"):
        if cr >= 1.2:
            c.add(0.1, f"current ratio {num(cr)}")
        elif cr < 0.9:
            c.no(f"current ratio {num(cr)}")
    d = m.get("dilution_1y")
    if d is None:
        c.miss("share count change")
    elif d <= 0.02:
        c.add(0.15, "no meaningful dilution" if d > -0.01 else f"share count down {pct(-d, 1)} (buybacks)")
    else:
        c.no(f"shares outstanding up {pct(d, 1)} in a year")
    if m.get("equity") is not None and m["equity"] <= 0:
        c.no("negative shareholders' equity")
        c.earned -= 0.2
    return c.clamp()


def quarantine(m: dict, snap: dict, events: list[dict], px: dict, liquid: bool) -> list[str]:
    q = []
    if snap.get("going_concern"):
        q.append("going-concern doubt disclosed in filings")
    for e in events:
        if e.get("item") in RED_FLAG_ITEMS:
            q.append(f"8-K {e['item']}: {ITEM_8K[e['item']][1]} ({e['filed']})")
    if not liquid:
        q.append("extreme illiquidity")
    if snap.get("revenue") is None and snap.get("net_income") is None and snap.get("assets") is None:
        q.append("no verified financial statements")
    return q


def review_flags(m: dict, events: list[dict], insider: dict) -> list[str]:
    f = []
    for e in events:
        if e.get("item") in REVIEW_ITEMS:
            f.append(f"8-K {e['item']}: {ITEM_8K[e['item']][1]} ({e['filed']})")
    if (m.get("net_debt_ebitda") or 0) > 4:
        f.append(f"high leverage (net debt/EBITDA {num(m['net_debt_ebitda'])})")
    if (m.get("dilution_1y") or 0) > 0.08:
        f.append(f"unusual dilution (+{pct(m['dilution_1y'])} shares in a year)")
    if m.get("fcf_growth") is not None and m["fcf_growth"] < -0.3 and (m.get("fcf") or 0) > 0:
        f.append("free cash flow down more than 30%")
    if m.get("op_margin") is not None and m.get("op_margin_prev") is not None and m["op_margin"] - m["op_margin_prev"] < -0.05:
        f.append("operating margin down 5+ points")
    if m.get("cash_runway_months") is not None and m["cash_runway_months"] < 18:
        f.append(f"cash runway ≈ {m['cash_runway_months']:.0f} months at current burn")
    if insider.get("sells_value_90d", 0) > 10 * max(1, insider.get("buys_value_90d", 0)) and insider.get("sells_value_90d", 0) > 5e6:
        f.append("heavy insider selling (not automatically bearish; review)")
    return f


def label(m: dict, px: dict, model: str, flags: list[str], quarantined: list[str]) -> str:
    if quarantined:
        return "Speculative"
    pts = 0
    vol = px.get("vol_1y")
    if vol is not None:
        pts += 2 if vol > 0.6 else 1 if vol > 0.35 else 0
    if model not in FIN:
        lev = m.get("net_debt_ebitda")
        pts += 2 if (lev or 0) > 4 else 1 if (lev or 0) > 2.5 else 0
        if (m.get("fcf") or 0) < 0:
            pts += 2
    if (m.get("net_income") or 0) < 0:
        pts += 1
    pts += min(2, len(flags))
    if (px.get("max_dd_1y") or 0) > 0.5:
        pts += 1
    return "Low" if pts <= 1 else "Moderate" if pts <= 3 else "High" if pts <= 6 else "Speculative"


def scenarios(m: dict, model: str, sector_med: dict, peer_med: dict) -> dict:
    """Bear/base/bull equity values from multiples the stock and its peers actually traded at.
    No estimate is invented: with fewer than two reference multiples or no positive base metric → unavailable."""
    h = m.get("history") or {}
    if model in FIN:
        base_metric, key, label_ = m.get("equity"), "pb", "book value × P/B"
        refs = [r for r in (sector_med.get("pb"), peer_med.get("pb")) if r]
    elif model == "reit":
        base_metric, key, label_ = m.get("ffo_approx"), "p_ffo", "approx. FFO × P/FFO"
        refs = [r for r in (sector_med.get("p_ffo"), peer_med.get("p_ffo")) if r]
    else:
        base_metric, key, label_ = m.get("net_income"), "pe", "TTM earnings × P/E"
        refs = [r for r in (h.get("pe_5y"), h.get("pe_3y"), sector_med.get("pe"), peer_med.get("pe")) if r]
    mcap = m.get("mcap")
    if not mcap or not base_metric or base_metric <= 0 or len(refs) < 2:
        return {"available": False, "why": "not enough reliable inputs (needs positive earnings/book and 2+ reference multiples)"}
    k = mcap / (m.get(key) * base_metric) if m.get(key) else 1.0  # FX factor between statements and price
    lo, mid, hi = min(refs), median(refs), max(refs)
    bear = lo * base_metric * k * 0.85  # bear also assumes a 15% hit to the base metric
    base = mid * base_metric * k
    bull = hi * base_metric * k
    up, down = base / mcap - 1, 1 - bear / mcap
    return {
        "available": True, "method": label_, "horizon": "12–24 months",
        "bear": bear, "base": base, "bull": bull,
        "upside_base": up, "downside_bear": down,
        "reward_risk": (up / down) if down > 0 else None,
        "assumptions": [f"reference {key.upper()} multiples: {', '.join(f'{r:.1f}' for r in refs)}", "bear case: lowest multiple and a 15% lower base metric",
                        "values are equity (market cap) levels, not price targets"],
        "invalidation": ["the base metric falls more than 15%", "new filing shows restated or deteriorating cash flow"],
    }
