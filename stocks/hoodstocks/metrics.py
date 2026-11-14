"""Turn a fundamentals snapshot + prices into ratios. Pure functions; None means 'not available', never zero."""
from __future__ import annotations

from statistics import median

from . import fundamentals as F
from .prices import close_on, split_factor_after

NOPAT_TAX = 0.21  # documented assumption for ROIC


def div(a, b):
    if a is None or b is None or b == 0:
        return None
    return a / b


def growth(cur, prev):
    if cur is None or prev is None or prev <= 0:
        return None
    return cur / prev - 1


def market_cap(snap: dict, price: float | None, splits: list[dict], price_fx: float = 1.0) -> dict | None:
    """Price × latest reported shares outstanding, adjusted for splits after the share-count date."""
    sh = snap.get("shares_outstanding")
    if not sh or price is None or not sh.get("value"):
        return None
    shares = sh["value"] * split_factor_after(splits, sh["end"])
    return {"value": price * shares * price_fx, "shares": shares, "shares_date": sh["end"], "shares_source": sh.get("accn")}


def compute(snap: dict, *, price: float | None, splits: list[dict], bars: list[dict], model: str, price_fx: float = 1.0,
            stmt_fx: float | None = 1.0) -> dict:
    """price_fx converts the quote currency to USD, stmt_fx converts the reporting currency to USD.
    stmt_fx None (unknown reporting currency) → no price-based ratios rather than wrong ones."""
    v = F.val
    mc = market_cap(snap, price, splits, price_fx)
    mcap = mc["value"] if mc else None
    rev, ni, oi, gp = v(snap.get("revenue")), v(snap.get("net_income")), v(snap.get("operating_income")), v(snap.get("gross_profit"))
    dna = v(snap.get("dna"))
    ebitda = oi + dna if oi is not None and dna is not None else None
    cash = (v(snap.get("cash")) or 0) + (v(snap.get("short_investments")) or 0) if snap.get("cash") else None
    debt = F.total_debt(snap)
    fcf = F.fcf(snap)
    fcf_prev = F.fcf(snap, "_prev")
    equity = v(snap.get("equity"))
    k = stmt_fx
    if k is None:
        mcap = None
        k = 1.0
    ev = mcap + (debt or 0) * k - (cash or 0) * k if mcap is not None and debt is not None and cash is not None else None
    m = {
        "mcap": mcap, "mcap_detail": mc, "ev": ev,
        "revenue": rev, "net_income": ni, "operating_income": oi, "ebitda": ebitda, "fcf": fcf, "ocf": v(snap.get("ocf")),
        "cash": cash, "debt": debt, "net_debt": debt - cash if debt is not None and cash is not None else None, "equity": equity,
        "pe": div(mcap, ni * k) if ni and ni > 0 and mcap else None,
        "earnings_yield": div(ni * k, mcap) if ni is not None and mcap else None,
        "ps": div(mcap, rev * k) if rev and mcap else None,
        "pb": div(mcap, equity * k) if equity and equity > 0 and mcap else None,
        "ev_ebitda": div(ev, ebitda * k) if ev and ebitda and ebitda > 0 else None,
        "fcf_yield": div(fcf * k, mcap) if fcf is not None and mcap else None,
        "gross_margin": div(gp, rev), "op_margin": div(oi, rev), "net_margin": div(ni, rev),
        "gross_margin_prev": div(v(snap.get("gross_profit_prev")), v(snap.get("revenue_prev"))),
        "op_margin_prev": div(v(snap.get("operating_income_prev")), v(snap.get("revenue_prev"))),
        "rev_growth": growth(rev, v(snap.get("revenue_prev"))),
        "ni_growth": growth(ni, v(snap.get("net_income_prev"))),
        "eps_growth": growth(v(snap.get("eps_diluted")), v(snap.get("eps_diluted_prev"))),
        "fcf_growth": growth(fcf, fcf_prev),
        "roe": div(ni, equity) if equity and equity > 0 else None,
        "roa": div(ni, v(snap.get("assets"))),
        "roic": div(oi * (1 - NOPAT_TAX), (debt or 0) + equity - (cash or 0)) if oi is not None and equity and debt is not None and cash is not None and ((debt or 0) + equity - (cash or 0)) > 0 else None,
        "debt_to_equity": div(debt, equity) if equity and equity > 0 and debt is not None else None,
        "net_debt_ebitda": div(debt - cash, ebitda) if debt is not None and cash is not None and ebitda and ebitda > 0 else None,
        "interest_coverage": div(oi, v(snap.get("interest_expense"))) if v(snap.get("interest_expense")) and v(snap.get("interest_expense")) > 0 else None,
        "current_ratio": div(v(snap.get("current_assets")), v(snap.get("current_liabilities"))),
        "equity_to_assets": div(equity, v(snap.get("assets"))),
        "dilution_1y": growth(v(snap.get("shares_outstanding")), v(snap.get("shares_outstanding_prev"))),
        "fcf_payout": div(v(snap.get("dividends_paid")), fcf) if fcf and fcf > 0 else None,
        "earnings_payout": div(v(snap.get("dividends_paid")), ni) if ni and ni > 0 else None,
        "cash_runway_months": (cash / (-fcf) * 12) if fcf is not None and fcf < 0 and cash is not None else None,
        "sbc_to_rev": div(v(snap.get("sbc")), rev),
    }
    if model == "reit" and ni is not None and dna is not None:
        ffo = ni + dna  # approximation: real FFO also removes property-sale gains (not tagged consistently)
        m["ffo_approx"] = ffo
        m["p_ffo"] = div(mcap, ffo * k) if ffo > 0 and mcap else None
        m["ffo_payout"] = div(v(snap.get("dividends_paid")), ffo) if ffo > 0 else None
    m["history"] = history_multiples(snap, bars, splits, price_fx / k if k else 1.0)
    return m


def history_multiples(snap: dict, bars: list[dict], splits: list[dict], k: float = 1.0) -> dict:
    """P/E, P/S, EV/EBITDA and FCF yield at each fiscal year end (price on that date × split-adjusted shares).
    k converts market cap into the statements' currency (multiples are currency-neutral once both match)."""
    sh_rows = snap.get("shares_rows") or []
    out = []
    ni = {r["end"]: r["value"] for r in snap.get("net_income_annual", [])}
    rev = {r["end"]: r["value"] for r in snap.get("revenue_annual", [])}
    ocf = {r["end"]: r["value"] for r in snap.get("ocf_annual", [])}
    capex = {r["end"]: r["value"] for r in snap.get("capex_annual", [])}
    oi = {r["end"]: r["value"] for r in snap.get("operating_income_annual", [])}
    dna = {r["end"]: r["value"] for r in snap.get("dna_annual", [])}
    for end in sorted(set(ni) | set(rev)):
        px = close_on(bars, end)
        cands = [r for r in sh_rows if r[0] <= end] or sh_rows[:1]
        if px is None or not cands:
            continue
        sh_end, shares = cands[-1][0], cands[-1][1]
        # prices are split-adjusted to today; bring share count to today's basis too
        mcap = px * shares * split_factor_after(splits, sh_end) * k
        row = {"end": end, "mcap": mcap}
        if ni.get(end) and ni[end] > 0:
            row["pe"] = mcap / ni[end]
        if rev.get(end):
            row["ps"] = mcap / rev[end]
        if ocf.get(end) is not None:
            f = ocf[end] - (capex.get(end) or 0)
            row["fcf_yield"] = f / mcap if mcap else None
        if oi.get(end) is not None and dna.get(end) is not None and (oi[end] + dna[end]) > 0:
            row["ev_ebitda_approx"] = mcap / (oi[end] + dna[end])  # equity value basis (historical debt not reconstructed)
        out.append(row)

    def avg(key, n):
        xs = [r[key] for r in out[-n:] if r.get(key) is not None and 0 < r[key] < 500]
        return sum(xs) / len(xs) if len(xs) >= min(n, 3) else None

    return {"years": out, "pe_3y": avg("pe", 3), "pe_5y": avg("pe", 5), "ps_3y": avg("ps", 3), "ps_5y": avg("ps", 5),
            "fcf_yield_5y": avg("fcf_yield", 5)}


def peer_medians(rows: list[dict], key_of, metrics=("pe", "ps", "ev_ebitda", "fcf_yield", "pb", "p_ffo")) -> dict:
    """Median of each metric per group (sector or industry). Groups with < 5 members are left out."""
    groups: dict[str, dict[str, list]] = {}
    for r in rows:
        g = key_of(r)
        if not g:
            continue
        for mname in metrics:
            x = (r.get("m") or {}).get(mname)
            if x is not None and (mname == "fcf_yield" or 0 < x < 300):
                groups.setdefault(g, {}).setdefault(mname, []).append(x)
    return {g: {k: median(v) for k, v in ms.items() if len(v) >= 5} for g, ms in groups.items()}
