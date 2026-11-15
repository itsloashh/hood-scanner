"""Undervaluation engine. A falling price alone never counts as cheap: a drawdown only earns points
when a valuation measure (history, sector or peers) also says the stock is cheap."""
from __future__ import annotations

from .. import config
from .base import Component, num, pct

# Which multiples make sense for which business model
APPLICABLE = {
    "bank": {"pe", "pb"},
    "insurance": {"pe", "pb"},
    "financial": {"pe", "pb"},
    "reit": {"p_ffo", "pb"},
    "utility": {"pe", "ev_ebitda", "pb"},
    "energy": {"ev_ebitda", "fcf_yield", "pe"},
    "tech": {"pe", "ps", "ev_ebitda", "fcf_yield"},
    "general": {"pe", "ps", "ev_ebitda", "fcf_yield"},
}
LABEL = {"pe": "P/E", "ps": "P/S", "ev_ebitda": "EV/EBITDA", "fcf_yield": "FCF yield", "pb": "P/B", "p_ffo": "P/FFO (approx.)"}


def score(m: dict, px: dict, model: str, sector_med: dict, peer_med: dict) -> tuple[Component, dict]:
    c = Component("valuation")
    applicable = APPLICABLE.get(model, APPLICABLE["general"])
    for k in ("pe", "ps", "ev_ebitda", "fcf_yield", "pb", "p_ffo"):
        if k not in applicable:
            c.na.append(f"{LABEL[k]} not meaningful for a {model} business")
    cheap_signals = 0
    detail = {}
    h = m.get("history") or {}

    def cmp(metric, cur, ref, label, lower_is_cheaper=True, weight=0.18):
        nonlocal cheap_signals
        if cur is None or ref is None:
            return
        cheaper = cur < ref * 0.9 if lower_is_cheaper else cur > ref * 1.1
        detail[f"{metric}_vs_{label}"] = {"current": cur, "reference": ref}
        if cheaper:
            cheap_signals += 1
            c.add(weight, f"{LABEL[metric]} {num(cur) if metric != 'fcf_yield' else pct(cur, 1)} vs {label} {num(ref) if metric != 'fcf_yield' else pct(ref, 1)}")
        else:
            c.no(f"{LABEL[metric]} not below its {label}")

    # 1. Against its own history
    if "pe" in applicable:
        if m.get("pe") is None:
            c.miss("P/E (no positive earnings)" if (m.get("net_income") or 0) <= 0 else "P/E")
        else:
            cmp("pe", m["pe"], h.get("pe_5y") or h.get("pe_3y"), "5-yr average" if h.get("pe_5y") else "3-yr average")
    if "ps" in applicable and m.get("ps") is not None:
        cmp("ps", m["ps"], h.get("ps_5y") or h.get("ps_3y"), "5-yr average" if h.get("ps_5y") else "3-yr average", weight=0.1)
    # 2. Against sector and peers
    for k in ("pe", "ev_ebitda", "pb", "p_ffo", "ps"):
        if k in applicable and m.get(k) is not None:
            cmp(k, m[k], sector_med.get(k), "sector median", weight=0.12)
            cmp(k, m[k], peer_med.get(k), "industry median", weight=0.1)
    # 3. Cash generation
    if "fcf_yield" in applicable:
        fy = m.get("fcf_yield")
        if fy is None:
            c.miss("free cash flow")
        elif fy >= 0.08:
            c.add(0.3, f"FCF yield {pct(fy, 1)} (≥ 8%)")  # Nov 15: was 0.22
            cheap_signals += 1
        elif fy >= 0.05:
            c.add(0.2, f"FCF yield {pct(fy, 1)} (≥ 5%)")  # Nov 15: was 0.14
            cheap_signals += 1
        elif fy > 0:
            c.add(0.04, f"positive FCF yield {pct(fy, 1)}")
        else:
            c.no(f"negative free cash flow (yield {pct(fy, 1)})")
    # 4. Drawdown only counts alongside a valuation signal
    off = px.get("off_high")
    if off is not None and off >= config.VALUE["min_drawdown_52w"]:
        if cheap_signals:
            c.add(0.12, f"{pct(off)} below its 52-week high, with valuation support")
        else:
            c.no(f"{pct(off)} below its 52-week high, but no valuation measure says it's cheap — a decline alone isn't value")
    if m.get("roic") is not None and m["roic"] >= 0.12 and model not in ("bank", "insurance", "financial", "reit"):
        c.add(0.15, f"ROIC {pct(m['roic'])} — cheapness of a high-return business")  # Nov 15: was 0.08
    c.clamp()
    detail["cheap_signals"] = cheap_signals
    return c, detail
