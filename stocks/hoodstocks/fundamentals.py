"""Financial statements from SEC XBRL company facts (deterministic, point-in-time aware).

Every value keeps: period start/end, filing date, form and accession → the source filing.
When a later filing restates a period, both versions are kept and the period is flagged `restated`."""
from __future__ import annotations

from datetime import date, datetime, timedelta

# Concept preference lists (first available wins). us-gaap for US filers, ifrs-full for 40-F/20-F filers.
FLOW = {
    "revenue": [("us-gaap", "Revenues"), ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"), ("us-gaap", "SalesRevenueNet"),
                ("us-gaap", "RevenuesNetOfInterestExpense"), ("us-gaap", "RevenueFromContractWithCustomerIncludingAssessedTax"), ("ifrs-full", "Revenue")],
    "gross_profit": [("us-gaap", "GrossProfit"), ("ifrs-full", "GrossProfit")],
    "operating_income": [("us-gaap", "OperatingIncomeLoss"), ("ifrs-full", "ProfitLossFromOperatingActivities")],
    "net_income": [("us-gaap", "NetIncomeLoss"), ("us-gaap", "NetIncomeLossAvailableToCommonStockholdersBasic"), ("us-gaap", "ProfitLoss"),
                   ("ifrs-full", "ProfitLossAttributableToOwnersOfParent"), ("ifrs-full", "ProfitLoss")],
    "eps_diluted": [("us-gaap", "EarningsPerShareDiluted"), ("us-gaap", "EarningsPerShareBasicAndDiluted"), ("ifrs-full", "DilutedEarningsLossPerShare")],
    "ocf": [("us-gaap", "NetCashProvidedByUsedInOperatingActivities"), ("us-gaap", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"),
            ("ifrs-full", "CashFlowsFromUsedInOperatingActivities")],
    "capex": [("us-gaap", "PaymentsToAcquirePropertyPlantAndEquipment"), ("us-gaap", "PaymentsToAcquireProductiveAssets"),
              ("ifrs-full", "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities")],
    "dna": [("us-gaap", "DepreciationDepletionAndAmortization"), ("us-gaap", "DepreciationAndAmortization"), ("us-gaap", "DepreciationAmortizationAndAccretionNet"),
            ("us-gaap", "Depreciation"), ("ifrs-full", "DepreciationAndAmortisationExpense")],
    "interest_expense": [("us-gaap", "InterestExpense"), ("us-gaap", "InterestExpenseNonoperating"), ("us-gaap", "InterestExpenseDebt"), ("ifrs-full", "FinanceCosts")],
    "dividends_paid": [("us-gaap", "PaymentsOfDividendsCommonStock"), ("us-gaap", "PaymentsOfDividends"), ("ifrs-full", "DividendsPaidClassifiedAsFinancingActivities")],
    "dps_declared": [("us-gaap", "CommonStockDividendsPerShareDeclared"), ("us-gaap", "CommonStockDividendsPerShareCashPaid")],
    "buybacks": [("us-gaap", "PaymentsForRepurchaseOfCommonStock"), ("ifrs-full", "PaymentsToAcquireOrRedeemEntitysShares")],
    "sbc": [("us-gaap", "ShareBasedCompensation"), ("us-gaap", "AllocatedShareBasedCompensationExpense")],
    "net_interest_income": [("us-gaap", "InterestIncomeExpenseNet"), ("us-gaap", "InterestIncomeExpenseAfterProvisionForLoanLoss")],
    "diluted_shares": [("us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding")],
}
INSTANT = {
    "cash": [("us-gaap", "CashAndCashEquivalentsAtCarryingValue"), ("us-gaap", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"), ("ifrs-full", "CashAndCashEquivalents")],
    "short_investments": [("us-gaap", "ShortTermInvestments"), ("us-gaap", "MarketableSecuritiesCurrent"), ("us-gaap", "AvailableForSaleSecuritiesDebtSecuritiesCurrent")],
    "debt_lt": [("us-gaap", "LongTermDebtNoncurrent"), ("us-gaap", "LongTermDebtAndCapitalLeaseObligations"), ("ifrs-full", "NoncurrentPortionOfNoncurrentBorrowings"),
                ("ifrs-full", "LongtermBorrowings")],
    "debt_current": [("us-gaap", "LongTermDebtCurrent"), ("us-gaap", "DebtCurrent"), ("us-gaap", "LongTermDebtAndCapitalLeaseObligationsCurrent"),
                     ("ifrs-full", "CurrentPortionOfNoncurrentBorrowings")],
    "short_borrowings": [("us-gaap", "ShortTermBorrowings"), ("us-gaap", "CommercialPaper"), ("ifrs-full", "ShorttermBorrowings")],
    "debt_total": [("us-gaap", "LongTermDebt"), ("us-gaap", "DebtInstrumentCarryingAmount"), ("ifrs-full", "Borrowings")],
    "equity": [("us-gaap", "StockholdersEquity"), ("us-gaap", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"),
               ("ifrs-full", "EquityAttributableToOwnersOfParent"), ("ifrs-full", "Equity")],
    "assets": [("us-gaap", "Assets"), ("ifrs-full", "Assets")],
    "liabilities": [("us-gaap", "Liabilities"), ("ifrs-full", "Liabilities")],
    "current_assets": [("us-gaap", "AssetsCurrent"), ("ifrs-full", "CurrentAssets")],
    "current_liabilities": [("us-gaap", "LiabilitiesCurrent"), ("ifrs-full", "CurrentLiabilities")],
    "goodwill": [("us-gaap", "Goodwill"), ("ifrs-full", "Goodwill")],
    "shares_outstanding": [("dei", "EntityCommonStockSharesOutstanding"), ("us-gaap", "CommonStockSharesOutstanding"),
                           ("ifrs-full", "NumberOfSharesOutstanding")],
}
FLAGS = {
    "going_concern": [("us-gaap", "SubstantialDoubtAboutGoingConcernWithinOneYear"), ("us-gaap", "SubstantialDoubtAboutGoingConcernManagementsEvaluation")],
}
ANNUAL_FORMS = {"10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A", "10-KT"}


def _d(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _units(facts: dict, tax: str, concept: str) -> list[dict] | None:
    c = ((facts.get("facts") or {}).get(tax) or {}).get(concept)
    if not c:
        return None
    units = c.get("units") or {}
    for u in ("USD", "USD/shares", "shares", "CAD", "CAD/shares", "pure"):
        if u in units:
            return [dict(x, unit=u) for x in units[u]]
    return next(iter(units.values()), None)


def compact_facts(facts: dict, max_years: int = 7) -> dict:
    """Shrink companyfacts (MBs) to the series we use: {metric: {concept, unit, rows:[[start,end,val,filed,form,accn]]}}."""
    cutoff = (date.today() - timedelta(days=366 * max_years)).isoformat()
    out = {"entity": facts.get("entityName"), "cik": facts.get("cik")}
    for group in (FLOW, INSTANT, FLAGS):
        for metric, prefs in group.items():
            for tax, concept in prefs:
                rows = _units(facts, tax, concept)
                if not rows:
                    continue
                keep = [[r.get("start"), r["end"], r["val"], r.get("filed"), r.get("form"), r.get("accn"), r.get("fp")] for r in rows if r.get("end", "") >= cutoff]
                if keep:
                    out[metric] = {"concept": f"{tax}:{concept}", "unit": rows[0].get("unit"), "rows": keep}
                    break
    return out


def _dedupe(rows: list[list], as_of: str | None) -> tuple[dict, set]:
    """(start,end) → latest-filed value as of `as_of`; also return periods that were restated."""
    best: dict[tuple, list] = {}
    seen_vals: dict[tuple, set] = {}
    for r in rows:
        start, end, val, filed = r[0], r[1], r[2], r[3]
        if as_of and filed and filed > as_of:
            continue  # not public yet at that date (point-in-time)
        k = (start, end)
        seen_vals.setdefault(k, set()).add(round(float(val), 2))
        if k not in best or (filed or "") > (best[k][3] or ""):
            best[k] = r
    restated = {k for k, v in seen_vals.items() if len(v) > 1}
    return best, restated


def _days(start, end) -> int:
    return (_d(end) - _d(start)).days


def ttm(series: dict | None, as_of: str | None = None) -> dict | None:
    """Trailing-twelve-month value for a flow metric: 4 latest contiguous quarters (deriving Q4 = FY − Q1..Q3),
    falling back to the latest fiscal year. Returns {value, start, end, filed, accn, form, basis}."""
    if not series:
        return None
    best, restated = _dedupe(series["rows"], as_of)
    if not best:
        return None
    quarters = {k: v for k, v in best.items() if k[0] and 80 <= _days(*k) <= 100}
    years = {k: v for k, v in best.items() if k[0] and 350 <= _days(*k) <= 380}
    # derive missing Q4s from fiscal years
    for (ys, ye), yr in years.items():
        inside = [(k, v) for k, v in quarters.items() if k[0] >= ys and k[1] <= ye]
        if len(inside) == 3:
            last_q_end = max(k[1] for k, _ in inside)
            if last_q_end < ye:
                q4 = yr[2] - sum(v[2] for _, v in inside)
                quarters[(last_q_end, ye)] = [last_q_end, ye, q4, yr[3], yr[4], yr[5], "Q4*"]
    latest_year = max(years.items(), key=lambda kv: kv[0][1]) if years else None
    if len(quarters) >= 4:
        qs = sorted(quarters.items(), key=lambda kv: kv[0][1])[-4:]
        contiguous = all(abs(_days(qs[i][0][1], qs[i + 1][0][0])) <= 5 for i in range(3)) and _days(qs[0][0][0], qs[-1][0][1]) <= 380
        if contiguous and (not latest_year or qs[-1][0][1] >= latest_year[0][1]):
            last = qs[-1][1]
            return {"value": sum(q[1][2] for q in qs), "start": qs[0][0][0], "end": qs[-1][0][1], "filed": max(q[1][3] or "" for q in qs),
                    "accn": last[5], "form": last[4], "basis": "TTM (4 quarters)", "restated": any(q[0] in restated for q in qs), "concept": series["concept"]}
    if latest_year:
        (s, e), r = latest_year
        return {"value": r[2], "start": s, "end": e, "filed": r[3], "accn": r[5], "form": r[4], "basis": "fiscal year", "restated": (s, e) in restated, "concept": series["concept"]}
    return None


def ttm_year_ago(series: dict | None, as_of: str | None = None) -> dict | None:
    """The TTM value ending ~1 year before the latest TTM (for growth rates)."""
    cur = ttm(series, as_of)
    if not cur:
        return None
    cutoff = date.fromordinal(_d(cur["end"]).toordinal() - 330).isoformat()
    sub = {"concept": series["concept"], "rows": [r for r in series["rows"] if r[1] <= cutoff]}
    prev = ttm(sub, as_of)
    if prev and 330 <= _days(prev["end"], cur["end"]) <= 400:
        return prev
    return None


def annual(series: dict | None, as_of: str | None = None) -> list[dict]:
    """Fiscal-year values oldest → newest."""
    if not series:
        return []
    best, restated = _dedupe(series["rows"], as_of)
    ys = [(k, v) for k, v in best.items() if k[0] and 350 <= _days(*k) <= 380]
    ys.sort(key=lambda kv: kv[0][1])
    return [{"start": k[0], "end": k[1], "value": v[2], "filed": v[3], "accn": v[5], "form": v[4], "restated": k in restated} for k, v in ys]


def instant(series: dict | None, as_of: str | None = None) -> dict | None:
    """Latest point-in-time balance (e.g. cash on the last balance sheet date)."""
    if not series:
        return None
    rows = [r for r in series["rows"] if not r[0] and (not as_of or not r[3] or r[3] <= as_of)]
    if not rows:
        rows = [r for r in series["rows"] if not as_of or not r[3] or r[3] <= as_of]
    if not rows:
        return None
    r = max(rows, key=lambda r: (r[1], r[3] or ""))
    return {"value": r[2], "end": r[1], "filed": r[3], "accn": r[5], "form": r[4], "concept": series["concept"]}


def instant_year_ago(series: dict | None, as_of: str | None = None) -> dict | None:
    cur = instant(series, as_of)
    if not cur:
        return None
    end = _d(cur["end"])
    lo = date(end.year - 1, end.month, 1).isoformat()
    hi = date(end.year - 1, end.month, 28).isoformat()
    rows = [r for r in series["rows"] if not r[0] and lo <= r[1] <= hi and (not as_of or (r[3] or "") <= as_of)]
    if not rows:
        return None
    r = max(rows, key=lambda r: (r[1], r[3] or ""))
    return {"value": r[2], "end": r[1], "filed": r[3], "accn": r[5]}


def snapshot(cf: dict, as_of: str | None = None) -> dict:
    """Everything the engines need, each value with its provenance. None = not reported (never zero-filled)."""
    g = lambda m: cf.get(m)  # noqa: E731
    s: dict = {"entity": cf.get("entity"), "as_of": as_of}
    for m in FLOW:
        s[m] = ttm(g(m), as_of)
        s[m + "_prev"] = ttm_year_ago(g(m), as_of)
    for m in INSTANT:
        s[m] = instant(g(m), as_of)
        s[m + "_prev"] = instant_year_ago(g(m), as_of)
    s["revenue_annual"] = annual(g("revenue"), as_of)
    s["net_income_annual"] = annual(g("net_income"), as_of)
    s["ocf_annual"] = annual(g("ocf"), as_of)
    s["capex_annual"] = annual(g("capex"), as_of)
    s["operating_income_annual"] = annual(g("operating_income"), as_of)
    s["dna_annual"] = annual(g("dna"), as_of)
    s["dps_annual"] = annual(g("dps_declared"), as_of)
    s["dividends_paid_annual"] = annual(g("dividends_paid"), as_of)
    s["shares_rows"] = sorted(([r[1], r[2], r[3]] for r in (g("shares_outstanding") or {}).get("rows", []) if not as_of or (r[3] or "") <= as_of), key=lambda r: r[0])
    gc = g("going_concern")
    s["going_concern"] = bool(gc and any(r[2] in (True, 1, "true") for r in gc["rows"] if not as_of or (r[3] or "") <= as_of))
    filed = [v["filed"] for k, v in s.items() if isinstance(v, dict) and v.get("filed")]
    s["latest_filed"] = max(filed) if filed else None
    s["latest_period"] = max((v["end"] for k, v in s.items() if isinstance(v, dict) and v.get("end") and k in ("revenue", "net_income", "assets")), default=None)
    return s


def val(x: dict | None) -> float | None:
    return None if x is None else x.get("value")


def total_debt(s: dict) -> float | None:
    parts = [val(s.get("debt_lt")), val(s.get("debt_current")), val(s.get("short_borrowings"))]
    if any(p is not None for p in parts[:1]):
        return sum(p for p in parts if p is not None)
    if val(s.get("debt_total")) is not None:
        return val(s.get("debt_total")) + (val(s.get("short_borrowings")) or 0)
    if any(p is not None for p in parts):
        return sum(p for p in parts if p is not None)
    return None


def fcf(s: dict, key: str = "") -> float | None:
    o, c = val(s.get("ocf" + key)), val(s.get("capex" + key))
    if o is None:
        return None
    return o - (c or 0)
