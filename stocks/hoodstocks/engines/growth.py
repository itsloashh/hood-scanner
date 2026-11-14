"""Growth engine: revenue, EPS, FCF and margin trends from filings, plus filed catalysts (8-K items)."""
from __future__ import annotations

from .base import Component, pct

POSITIVE_ITEMS = {"1.01": "material agreement", "2.01": "completed acquisition", "5.01": "change in control"}


def score(m: dict, catalysts: list[dict]) -> Component:
    c = Component("growth_catalysts")
    g = m.get("rev_growth")
    if g is None:
        c.miss("revenue growth (needs two comparable periods)")
    elif g >= 0.25:
        c.add(0.3, f"revenue +{pct(g)} y/y")
    elif g >= 0.1:
        c.add(0.2, f"revenue +{pct(g)} y/y")
    elif g > 0.03:
        c.add(0.08, f"revenue +{pct(g)} y/y")
    else:
        c.no(f"revenue growth {pct(g)}")
    e = m.get("eps_growth") if m.get("eps_growth") is not None else m.get("ni_growth")
    if e is None:
        c.miss("earnings growth")
    elif e >= 0.15:
        c.add(0.2, f"earnings +{pct(e)} y/y")
    elif e > 0.03:
        c.add(0.1, f"earnings +{pct(e)} y/y")
    else:
        c.no(f"earnings growth {pct(e)}")
    f = m.get("fcf_growth")
    if f is not None and f > 0.1 and (m.get("fcf") or 0) > 0:
        c.add(0.15, f"free cash flow +{pct(f)} y/y")
    om, omp = m.get("op_margin"), m.get("op_margin_prev")
    if om is not None and omp is not None:
        if om - omp >= 0.01:
            c.add(0.15, f"operating margin up {pct(om - omp, 1)} to {pct(om)}")
        elif om - omp <= -0.02:
            c.no(f"operating margin down {pct(omp - om, 1)}")
    gm, gmp = m.get("gross_margin"), m.get("gross_margin_prev")
    if gm is not None and gmp is not None and gm - gmp >= 0.01:
        c.add(0.05, f"gross margin up {pct(gm - gmp, 1)}")
    seen = set()
    for ev in catalysts:
        if ev.get("item") in POSITIVE_ITEMS and ev["item"] not in seen:
            seen.add(ev["item"])
            c.add(0.08, f"8-K {ev['item']} {POSITIVE_ITEMS[ev['item']]} filed {ev['filed']} (details in filing)")
    c.na.append("forward estimates / earnings revisions: no free consensus source")
    return c.clamp()
