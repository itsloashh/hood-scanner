"""Quality / value overlay (Nov 15). A Value-lens name must also look like a good business, or it can't
reach an Opportunity alert (unless insiders are buying heavily at the same time).

Passes when EITHER:
  • high ROIC (≥12%) AND cheap on earnings: earnings yield ≥6% or EBIT/EV ≥8%, OR
  • an F-Score-style check scores ≥7 of 9 (scaled to 9 when some items can't be measured).

The F-Score here is built from what the filings give us; items marked (proxy) stand in for Piotroski's
year-over-year balance-sheet comparisons we don't store."""
from __future__ import annotations

from .. import config


def fscore(m: dict, model: str) -> dict:
    fin = model in ("bank", "insurance", "financial")
    items: list[tuple[str, bool | None]] = []
    ni, ocf = m.get("net_income"), m.get("ocf")
    items.append(("profitable (ROA > 0)", None if ni is None else ni > 0))
    items.append(("operating cash flow positive", None if ocf is None else ocf > 0))
    g = m.get("ni_growth")
    items.append(("earnings rising (ROA improving, proxy)", None if g is None else g > 0))
    items.append(("cash flow above earnings (accrual quality)", None if ocf is None or ni is None else ocf > ni))
    if not fin:
        nde = m.get("net_debt_ebitda")
        items.append(("low leverage (net cash or net debt/EBITDA ≤ 2.5, proxy)", True if (m.get("net_debt") is not None and m["net_debt"] <= 0) else None if nde is None else nde <= 2.5))
        cr = m.get("current_ratio")
        items.append(("current ratio ≥ 1 (proxy)", None if cr is None else cr >= 1.0))
    d = m.get("dilution_1y")
    items.append(("no new shares issued", None if d is None else d <= 0.02))
    gm, gmp = m.get("gross_margin"), m.get("gross_margin_prev")
    if not fin:
        items.append(("gross margin not falling", None if gm is None or gmp is None else gm >= gmp))
    rg = m.get("rev_growth")
    items.append(("sales growing (asset turnover, proxy)", None if rg is None else rg > 0))
    known = [(k, v) for k, v in items if v is not None]
    if len(known) < 5:
        return {"score": None, "of": 9, "passed": [], "failed": [], "why": "not enough data for an F-Score"}
    raw = sum(1 for _, v in known if v)
    return {"score": round(raw / len(known) * 9, 1), "of": 9, "measured": len(known),
            "passed": [k for k, v in known if v], "failed": [k for k, v in known if not v]}


def overlay(m: dict, model: str) -> dict:
    Q = config.QUALITY
    roic, ey = m.get("roic"), m.get("earnings_yield")
    ev, oi = m.get("ev"), m.get("operating_income")
    ebit_ev = (oi / ev) if ev and ev > 0 and oi is not None else None
    cheap = (ey is not None and ey >= Q["min_earnings_yield"]) or (ebit_ev is not None and ebit_ev >= Q["min_ebit_ev"])
    magic = roic is not None and roic >= Q["min_roic"] and cheap
    fs = fscore(m, model)
    fs_ok = fs["score"] is not None and fs["score"] >= Q["min_fscore"]
    why = []
    if magic:
        why.append(f"ROIC {roic * 100:.0f}% with earnings yield {ey * 100:.1f}%" if ey is not None and ey >= Q["min_earnings_yield"] else f"ROIC {roic * 100:.0f}% with EBIT/EV {ebit_ev * 100:.1f}%")
    if fs["score"] is not None:
        why.append(f"F-Score {fs['score']:g}/9")
    return {"ok": bool(magic or fs_ok), "roic_cheap": bool(magic), "fscore": fs["score"], "fscore_detail": fs, "ebit_ev": ebit_ev, "why": why}


def strong_insiders(ins: dict) -> bool:
    """Very strong concurrent insider buying: 2+ insiders in 30 days with $250k+ bought, or a senior officer buying $250k+."""
    A = config.ALERT
    cluster = ins.get("buyers_30d", 0) >= A["insider_cluster_min_people"] and ins.get("buys_value_90d", 0) >= A["insider_min_value_usd"]
    senior = any(b.get("senior") and (b.get("value") or 0) >= A["insider_min_value_usd"] for b in ins.get("buys", []))
    return bool(cluster or senior)
