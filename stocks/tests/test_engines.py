"""Tests run on SYNTHETIC data only (see conftest.py)."""
from datetime import date, timedelta

import pytest

from conftest import bars_linear, fx
from hoodstocks import alerts as AL, config, fundamentals as F, master as M, metrics as MET, store
from hoodstocks.engines import confidence as CONF, dividend as DIV, etf as ETF, insider as INS, institutional as INST
from hoodstocks.engines import risk as RISK, scoring as SC, value as VAL
from hoodstocks.http import FetchError, Http
from hoodstocks.prices import forward_return, max_drawdown, split_factor_after, stats
from hoodstocks.providers import sec as SEC, yahoo as Y
from hoodstocks.providers.registry import snapshot as reg_snapshot


# 1–3. Ticker resolution, US and Canadian identification ─────────
def _master():
    sec_rows = [
        {"cik": 1, "name": "Synthetic Co", "ticker": "SYN", "exchange": "NYSE"},
        {"cik": 2, "name": "Maple Bank", "ticker": "MPL", "exchange": "NYSE"},
        {"cik": 3, "name": "Twin Class Inc", "ticker": "TWNA", "exchange": "Nasdaq"},
        {"cik": 3, "name": "Twin Class Inc", "ticker": "TWNB", "exchange": "Nasdaq"},
        {"cik": 4, "name": "Otc Thing", "ticker": "OTCX", "exchange": "OTC"},
    ]
    scr = {"SYN": {"price": 25, "mcap": 2.5e9, "volume": 1e6}, "MPL": {"price": 50, "mcap": 5e10, "volume": 2e6},
           "TWNA": {"price": 10, "mcap": 1e9, "volume": 5e6}, "TWNB": {"price": 10, "mcap": 1e9, "volume": 1e5}}
    subs = {
        "1": {"cik": "1", "name": "Synthetic Co", "sic": 7372, "country": "US", "former_names": [], "filings": []},
        "2": {"cik": "2", "name": "Maple Bank", "sic": 6022, "country": "CA", "former_names": [], "filings": []},
        "3": {"cik": "3", "name": "Twin Class", "sic": 3711, "country": "US", "former_names": [], "filings": []},
    }
    m = M.build(M.MasterInputs(sec_rows=sec_rows, screener=scr, subs=subs))
    m["SEC2"]["listings"].append({"ticker": "MPL.TO", "exchange": "TSX", "currency": "CAD", "yahoo": "MPL.TO"})
    M.add_etfs(m)
    return m


def test_ticker_resolution_and_share_classes():
    m = _master()
    assert M.resolve(m, "syn")["match"]["security_id"] == "SEC1"
    assert M.resolve(m, "$TWNB")["match"]["security_id"] == "SEC3-TWNB"  # second class gets its own id
    assert M.resolve(m, "TWNA")["match"]["security_id"] == "SEC3"
    assert "none" in M.resolve(m, "NOPE")
    assert "OTCX" not in {s["ticker"] for s in m.values()}  # OTC is not a verified exchange listing


def test_us_identification_uses_cik_not_ticker():
    m = _master()
    s = m["SEC1"]
    assert s["identifiers"]["cik"] == "1" and s["country"] == "US" and s["model"] == "tech" and s["sector"] == "Technology"


def test_canadian_identification_and_dual_listing():
    m = _master()
    s = M.resolve(m, "MPL.TO")["match"]
    assert s["security_id"] == "SEC2" and s["country"] == "CA" and s["model"] == "bank"
    assert {l["currency"] for l in s["listings"]} == {"USD", "CAD"}
    assert M.country_of({"addresses": {"business": {"stateOrCountry": "A6"}}}) == "CA"  # Ontario
    assert M.country_of({"addresses": {"business": {"stateOrCountry": "NY"}}}) == "US"


def test_ambiguous_ticker_is_not_guessed():
    m = _master()
    m["TSX-SYN.TO"] = {"security_id": "TSX-SYN.TO", "ticker": "SYN.TO", "name": "Other Syn", "exchange": "TSX",
                       "listings": [{"ticker": "SYN.TO", "exchange": "TSX", "currency": "CAD", "yahoo": "SYN.TO"}]}
    m["SEC1"]["listings"].append({"ticker": "SYN.TO", "exchange": "TSX", "currency": "CAD", "yahoo": "SYN.TO"})
    assert "ambiguous" in M.resolve(m, "SYN.TO")


def test_ticker_change_detected():
    old = {"SEC1": {"ticker": "OLD"}}
    new = {"SEC1": {"ticker": "SYN"}}
    ch = M.ticker_changes(old, new)
    assert ch[0]["from"] == "OLD" and ch[0]["to"] == "SYN"


# 4. Currency normalisation ──────────────────────────────────
def test_currency_normalisation_keeps_original_and_converts(facts):
    snap = F.snapshot(F.compact_facts(facts))
    bars = bars_linear(n=300, p0=30)
    usd = MET.compute(snap, price=30, splits=[], bars=bars, model="general", price_fx=1.0, stmt_fx=1.0)
    cad_px = MET.compute(snap, price=30 * 1.4, splits=[], bars=bars, model="general", price_fx=1 / 1.4, stmt_fx=1.0)
    assert usd["mcap"] == pytest.approx(cad_px["mcap"])  # same company priced in CAD → same USD market cap
    assert usd["pe"] == pytest.approx(cad_px["pe"])
    cad_stmts = MET.compute(snap, price=30, splits=[], bars=bars, model="general", price_fx=1.0, stmt_fx=1 / 1.4)
    assert cad_stmts["pe"] == pytest.approx(usd["pe"] * 1.4)  # CAD earnings are worth fewer USD
    unknown = MET.compute(snap, price=30, splits=[], bars=bars, model="general", price_fx=1.0, stmt_fx=None)
    assert unknown["pe"] is None  # unknown reporting currency → no ratio rather than a wrong one


# 5–6. Statement parsing and ratios ───────────────────────────
def test_financial_statement_parsing_ttm_and_q4_derivation(facts):
    cf = F.compact_facts(facts)
    t = F.ttm(cf["revenue"])
    # Q4 2024 derived as 560 − (125+135+145) = 155; TTM = 125+135+145+155
    assert t["value"] == pytest.approx(560) and t["basis"] == "TTM (4 quarters)"
    prev = F.ttm_year_ago(cf["revenue"])
    assert prev["value"] == pytest.approx(460)
    assert t["accn"] and t["filed"] == "2025-02-15"


def test_point_in_time_excludes_later_filings(facts):
    cf = F.compact_facts(facts)
    t = F.ttm(cf["revenue"], as_of="2024-06-01")  # only filings made by then
    assert t["end"] <= "2024-03-31"


def test_restatement_is_kept_and_flagged(facts):
    facts["facts"]["us-gaap"]["Revenues"]["units"]["USD"].append(
        {"start": "2024-01-01", "end": "2024-12-31", "val": 540, "filed": "2025-05-01", "form": "10-K/A", "accn": "0000000000-00-000099"})
    cf = F.compact_facts(facts)
    years = F.annual(cf["revenue"])
    assert years[-1]["value"] == 540 and years[-1]["restated"] is True
    old = F.annual(cf["revenue"], as_of="2025-03-01")
    assert old[-1]["value"] == 560  # the original version is still available point-in-time


def test_ratios(facts):
    snap = F.snapshot(F.compact_facts(facts))
    m = MET.compute(snap, price=30, splits=[], bars=bars_linear(n=300, p0=30), model="general")
    assert m["mcap"] == pytest.approx(3000)
    assert m["pe"] == pytest.approx(3000 / 112)
    assert m["fcf"] == pytest.approx(560 * 0.25)
    assert m["net_debt"] == pytest.approx(100 - 300)
    assert m["rev_growth"] == pytest.approx(560 / 460 - 1)
    assert m["debt_to_equity"] == pytest.approx(100 / 900)


# 7. Valuation ───────────────────────────────────────────────
def test_decline_alone_is_not_undervaluation(facts):
    snap = F.snapshot(F.compact_facts(facts))
    m = MET.compute(snap, price=30, splits=[], bars=bars_linear(n=300, p0=30), model="general")
    m["fcf_yield"] = 0.01
    px = {"off_high": 0.5}
    c, d = VAL.score(m, px, "general", {"pe": m["pe"] * 0.5}, {})  # pricier than sector, tiny FCF yield
    assert d["cheap_signals"] == 0
    assert not any("52-week" in r for r in c.reasons)
    assert any("decline alone" in w for w in c.withheld)


def test_bank_metrics_marked_not_applicable(facts):
    snap = F.snapshot(F.compact_facts(facts))
    m = MET.compute(snap, price=30, splits=[], bars=bars_linear(n=300, p0=30), model="bank")
    c, _ = VAL.score(m, {}, "bank", {}, {})
    assert any("EV/EBITDA" in x for x in c.na)


# 8–9. Institutional ────────────────────────────────────────
def test_13f_parse_aggregate_and_compare():
    rows = SEC.parse_13f_table(fx("13f.xml"))
    for r in rows:
        r["value_usd"] = SEC.thirteenf_value_usd(r["value_raw"], "2026-11-01")
    agg = INST.aggregate(rows)
    assert len(agg) == 1 and agg[0]["shares"] == 300000  # two lines summed, the call option excluded
    prev = [{"cusip": "000000AA1", "issuer": "SYNTHETIC CO", "shares": 100000, "value_usd": 1e6}]
    ch = INST.compare(prev, agg)
    assert ch[0]["change"] == "increase" and ch[0]["pct_change"] == pytest.approx(2.0)
    # a 3-for-1 split between the two periods makes the same holding "unchanged"
    ch2 = INST.compare(prev, agg, split_factor=lambda c: 3.0)
    assert ch2[0]["change"] == "unchanged" and ch2[0]["split_adjusted"]


def test_13f_value_units_and_reporting_delay_label():
    assert SEC.thirteenf_value_usd(5, "2022-11-14") == 5000  # thousands before 2023
    assert SEC.thirteenf_value_usd(5, "2023-05-15") == 5
    txt = INST.describe({"change": "new", "pct_change": None}, "Example Capital", "2026-09-30", "2026-11-14")
    assert "as of 2026-09-30" in txt and "13F filed 2026-11-14" in txt


def test_13f_holding_never_described_as_real_time_purchase():
    for kind in ("new", "increase", "decrease", "exit", "unchanged"):
        txt = INST.describe({"change": kind, "pct_change": 0.5}, "Example Capital", "2026-09-30", "2026-11-14").lower()
        for banned in ("bought today", "is buying", "just bought", "purchased today", "real-time", "live"):
            assert banned not in txt
        assert "as of" in txt and "filed" in txt
    c = INST.score([{"change": "new", "manager": "A"}, {"change": "increase", "manager": "B"}], [])
    assert any("not a live trade" in r for r in c.reasons)


# 10. Insider classification ─────────────────────────────────
def test_insider_classification():
    f = SEC.parse_form4(fx("form4.xml"))
    types = [t["type"] for t in f["transactions"]]
    assert types == ["open_market_purchase", "tax_withholding", "award"]
    assert f["transactions"][0]["value"] == pytest.approx(255000)
    assert f["transactions"][0]["owned_before"] == pytest.approx(50000)
    f["filed"] = "2026-11-04"
    s = INS.summarize([f], as_of="2026-11-10")
    assert len(s["buys"]) == 1 and s["senior_buy"] and s["buyers_30d"] == 1  # award and tax withholding ignored


def test_plan_trades_do_not_count():
    f = SEC.parse_form4(fx("form4.xml").replace("<periodOfReport>", "<aff10b5One>1</aff10b5One><periodOfReport>"))
    s = INS.summarize([dict(f, filed="2026-11-04")], as_of="2026-11-10")
    assert s["buys"] == []


def test_insider_sales_not_scored_bearish():
    c = INS.score({"buys": [], "sells_value_90d": 5e6})
    assert c.earned == 0 and not any("bearish" in r.lower() for r in c.reasons)


# 11. Dividends ──────────────────────────────────────────────
def test_dividend_yield_uses_last_12_months_only():
    today = date(2026, 11, 14)
    divs = [{"ex_date": (today - timedelta(days=d)).isoformat(), "amount": 0.5} for d in (30, 120, 210, 300, 400, 500)]
    y = DIV.ttm_yield(divs, 50.0, as_of=today.isoformat())
    assert y["yield"] == pytest.approx(2.0 / 50)  # four payments in the last 365 days, not six


def test_stale_distributions_never_produce_a_yield():
    divs = [{"ex_date": "2023-01-15", "amount": 1.0}, {"ex_date": "2023-04-15", "amount": 1.0}]
    y = DIV.ttm_yield(divs, 20.0, as_of="2026-11-14")
    assert y["yield"] is None and "stale" in y["why"]


def test_high_yield_requires_investigation():
    c = DIV.score({}, {"yield": 0.14, "years_paid": 10, "cuts": []}, "general")
    assert c.earned == 0 and any("investigation" in w for w in c.withheld)


def test_split_adjustment_of_share_counts():
    splits = [{"date": "2024-06-10", "ratio": 4.0}]
    assert split_factor_after(splits, "2024-01-31") == 4.0
    assert split_factor_after(splits, "2024-07-01") == 1.0


# 12. ETF ────────────────────────────────────────────────────
def test_etf_analysis_and_missing_parts_score_zero():
    bars = bars_linear(n=300, p0=50, step=0.02)
    a = ETF.analyze(bars, [], stats(bars))
    sc, comps, conf = ETF.score(a, "test")
    byname = {c["name"]: c for c in comps}
    assert byname["portfolio_quality"]["points"] == 0 and byname["flows_and_fees"]["points"] == 0
    assert conf < 50


# 13. Risk ───────────────────────────────────────────────────
def test_quarantine_conditions():
    snap = {"going_concern": True, "revenue": {"value": 1}}
    q = RISK.quarantine({}, snap, [{"item": "4.02", "filed": "2026-11-01"}], {}, liquid=False)
    assert any("going-concern" in x for x in q) and any("4.02" in x for x in q) and "extreme illiquidity" in q


def test_size_does_not_set_risk():
    m = {"net_debt_ebitda": 1.0, "fcf": 10, "net_income": 5}
    assert RISK.label(m, {"vol_1y": 0.2, "max_dd_1y": 0.1}, "general", [], []) == "Low"
    assert RISK.label(m, {"vol_1y": 0.9, "max_dd_1y": 0.7}, "general", ["a", "b"], []) in ("High", "Speculative")


def test_scenarios_unavailable_without_inputs():
    s = RISK.scenarios({"mcap": 100, "net_income": -5}, "general", {}, {})
    assert s["available"] is False


# 14–15. Scoring + confidence ─────────────────────────────────
def _comps(health=1.0, val=1.0, inst=0.0, growth=0.0):
    C = SC.Component
    return {"financial_health": C("financial_health", earned=health), "valuation": C("valuation", earned=val),
            "institutional": C("institutional", earned=inst), "growth_catalysts": C("growth_catalysts", earned=growth),
            "market_sector": C("market_sector", earned=1), "insider_strategic": C("insider_strategic", earned=1),
            "data_quality": C("data_quality", earned=1), "income_quality": C("income_quality", earned=0)}


def test_score_is_reproducible_and_explained():
    a = SC.combine(_comps(), "value", verified_financials=True, quarantined=[])
    b = SC.combine(_comps(), "value", verified_financials=True, quarantined=[])
    assert a == b and a["version"] == config.SCORE_VERSION
    assert set(a["components"]) == set(config.PROFILES["value"])


def test_cap_without_verified_financials():
    r = SC.combine(_comps(), "value", verified_financials=False, quarantined=[])
    assert r["score"] <= 69 and any("verified financial" in c for c in r["caps"])


def test_cap_when_case_rests_on_institutional_buying():
    r = SC.combine(_comps(health=0, val=0, inst=1, growth=0), "value", verified_financials=True, quarantined=[])
    assert r["score"] <= 79


def test_quarantine_blocks_priority():
    r = SC.combine(_comps(), "value", verified_financials=True, quarantined=["going-concern doubt"])
    assert r["score"] < 60


def test_missing_data_cannot_raise_scores():
    full = {"net_income": 100, "fcf": 50, "net_debt": -10, "interest_coverage": 10, "current_ratio": 2, "dilution_1y": 0.0, "equity": 500}
    base = RISK.health(full, "general").earned
    for k in list(full):
        partial = {kk: v for kk, v in full.items() if kk != k}
        assert RISK.health(partial, "general").earned <= base + 1e-9
    empty = RISK.health({}, "general")
    assert empty.earned == 0 and empty.missing


def test_confidence_is_independent_of_score():
    snap = {k: {"value": 1} for k in CONF.KEY_METRICS}
    hi = CONF.score(snap, {"sec_financials": True, "filing_age_days": 30, "price_fresh": True, "mcap_confirmed": True, "price_confirmed": True})
    lo = CONF.score(None, {"sec_financials": False, "price_fresh": False})
    assert hi["confidence"] >= 85 and lo["confidence"] <= 20
    r = SC.combine(_comps(), "value", verified_financials=True, quarantined=[])
    assert "confidence" not in r  # never blended into the opportunity score


# 16–17. Source verification + duplicates ──────────────────────
def test_sources_keep_provenance():
    s = store.source("SEC EDGAR XBRL", "https://www.sec.gov/x", reliability="primary", publication_date="2026-11-01", reporting_period="2026-09-30")
    assert {"provider", "url", "reliability", "retrieved", "verification", "reporting_period"} <= set(s)


def test_duplicate_news_counts_once():
    from hoodstocks.providers.news import norm_title
    assert norm_title("Synthetic Co beats estimates!") == norm_title("Synthetic Co Beats Estimates")


def test_daily_index_parse():
    rows = SEC.parse_form_index(fx("form.idx"))
    assert [r["form"] for r in rows] == ["10-Q", "4", "4", "SC 13D"]
    assert rows[0]["cik"] == "1" and rows[0]["date"] == "2026-11-13"


# 18. Alerts (dedupe + delivery) ──────────────────────────────
def _detail(score=82, conf=70, cls="Strong research candidate"):
    row = {"id": "SEC1", "ticker": "SYN", "name": "Synthetic Co", "exchange": "NYSE", "country": "US", "currency": "USD", "cap": "mid",
           "profile": "value", "sector": "Technology", "price": 25.0, "price_date": "2026-11-13", "mcap": 2.5e9, "score": score, "class": cls,
           "confidence": conf, "risk": "Moderate", "experimental": False, "quarantined": False,
           "quality_ok": True, "insider_strong": False}
    return {"row": row, "metrics": {}, "scenarios": {"available": False, "why": "test"}, "risk": {"review": [], "quarantine": []},
            "why": ["FCF yield 9%"], "institutional": []}


def test_alerts_deduplicate_and_score_change_alone_does_not_realert(monkeypatch):
    sent = []
    monkeypatch.setattr(AL, "send", lambda http, text, **k: sent.append(text) or True)
    al = AL.Alerts(http=None)
    al.db = {"sent": {}, "log": []}
    assert al.opportunity(_detail(), None)
    assert not al.opportunity(_detail(), None)  # same key
    assert not al.opportunity(_detail(score=85), {"score": 82})  # +3 isn't enough
    assert not al.opportunity(_detail(score=60), None)  # below threshold
    assert not al.opportunity(_detail(conf=30), None)  # weak evidence
    assert len(sent) == 1 and "not a buy instruction" in sent[0]


def test_quality_overlay_gates_value_opportunities(monkeypatch):
    """Nov 15: a Value-lens name that fails the quality overlay can't alert unless insiders are buying heavily."""
    from hoodstocks.engines import quality as Q
    good = {"net_income": 100, "ocf": 140, "ni_growth": 0.1, "net_debt": -5, "current_ratio": 1.6, "dilution_1y": 0.0,
            "gross_margin": 0.42, "gross_margin_prev": 0.40, "rev_growth": 0.06, "roic": 0.18, "earnings_yield": 0.07, "ev": 1000, "operating_income": 90}
    weak = {"net_income": -5, "ocf": -2, "ni_growth": -0.3, "net_debt_ebitda": 4.0, "current_ratio": 0.8, "dilution_1y": 0.09,
            "gross_margin": 0.30, "gross_margin_prev": 0.34, "rev_growth": -0.05, "roic": 0.03, "earnings_yield": -0.01}
    assert Q.fscore(good, "general")["score"] == 9
    assert Q.overlay(good, "general")["ok"] and Q.overlay(good, "general")["roic_cheap"]
    assert Q.fscore(weak, "general")["score"] <= 1 and not Q.overlay(weak, "general")["ok"]
    assert Q.fscore({"net_income": 1}, "general")["score"] is None  # too little data
    big = {"buyers_30d": 2, "buys_value_90d": 300_000, "buys": []}
    assert Q.strong_insiders(big) and not Q.strong_insiders({"buyers_30d": 2, "buys_value_90d": 120_000, "buys": []})
    assert Q.strong_insiders({"buyers_30d": 1, "buys_value_90d": 260_000, "buys": [{"senior": True, "value": 260_000}]})
    monkeypatch.setattr(AL, "send", lambda http, text, **k: True)
    al = AL.Alerts(http=None)
    al.db = {"sent": {}, "log": []}
    d = _detail()
    d["row"]["quality_ok"] = False
    assert not al.opportunity(d, None)
    d["row"]["insider_strong"] = True
    assert al.opportunity(d, None)
    g = _detail()
    g["row"].update({"id": "SEC2", "profile": "growth", "quality_ok": False})
    assert al.opportunity(g, None)  # the overlay only applies to Value-lens names
    assert not al.opportunity(_detail(score=71), None)  # bar is 72 now
    assert not al.opportunity(_detail(conf=54), None)  # confidence bar is 55 now


# 19. Telegram authorisation: only the configured chat ─────────
def test_telegram_uses_only_configured_chat(monkeypatch):
    from hoodstocks.providers import telegram
    calls = []

    class FakeHttp:
        def get(self, url, data=None, **k):
            calls.append(data)
            return b"{}"

    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "x")
    assert telegram.send(FakeHttp(), "hi") is False and not calls
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "123")
    assert telegram.send(FakeHttp(), "hi") is True
    assert b'"chat_id": "123"' in calls[0]


# 20–22. Returns, corporate actions, backtest integrity ────────
def test_historical_returns_and_drawdown():
    bars = bars_linear(start="2025-01-01", n=300, p0=100, step=0.1)
    r = forward_return(bars, bars[0]["t"], 30)
    assert r is not None and r > 0
    assert forward_return(bars, bars[-1]["t"], 30) is None  # window not finished → no number
    assert max_drawdown([100, 120, 60, 130]) == pytest.approx(0.5)


def test_backtest_uses_only_filed_data(facts):
    cf = F.compact_facts(facts)
    snap = F.snapshot(cf, as_of="2024-03-01")
    assert snap["revenue"]["end"] <= "2023-12-31"  # 2024 results weren't filed yet
    assert snap["latest_filed"] <= "2024-03-01"


# 23–24. Provider failure + stale data ─────────────────────────
def test_provider_failure_retries_then_marks_down(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    h = Http(max_retries=2, transport=lambda u, hd, d: (503, b"down"))
    with pytest.raises(FetchError):
        h.get("https://data.sec.gov/x")
    st = h.health()["data.sec.gov"]
    assert st["calls"] == 3 and st["errors"] == 1 and st["retries"] >= 2
    reg = reg_snapshot(h.health(), {"sec_edgar": ["data.sec.gov"]})
    assert reg["sec_edgar"]["status"] == "down"
    assert reg["political"]["status"] == "blocked"  # unavailable sources are explicit


def test_stale_price_lowers_data_quality():
    fresh = SC.data_quality({"sec_financials": True, "price_fresh": True})
    stale = SC.data_quality({"sec_financials": True, "price_fresh": False})
    assert stale.earned < fresh.earned and any("stale" in w for w in stale.withheld)


def test_yahoo_chart_parse():
    j = {"chart": {"result": [{"meta": {"symbol": "SYN", "currency": "USD", "regularMarketPrice": 2.0},
                               "timestamp": [1700000000, 1700086400],
                               "indicators": {"quote": [{"open": [1, 2], "high": [1, 2], "low": [1, 2], "close": [1.0, 2.0], "volume": [10, 20]}],
                                              "adjclose": [{"adjclose": [0.9, 2.0]}]},
                               "events": {"dividends": {"1700000000": {"amount": 0.1}}, "splits": {"1700086400": {"numerator": 2, "denominator": 1}}}}]}}
    c = Y.parse_chart(j)
    assert c["bars"][0]["adj"] == 0.9 and c["dividends"][0]["amount"] == 0.1 and c["splits"][0]["ratio"] == 2


def test_concept_switch_is_merged_not_stale(facts):
    """SYNTHETIC: company stops tagging 'Revenues' in 2023 and switches to the ASC 606 tag."""
    g = facts["facts"]["us-gaap"]
    old = [r for r in g["Revenues"]["units"]["USD"] if r["end"] < "2024-01-01"]
    new = [r for r in g["Revenues"]["units"]["USD"] if r["end"] >= "2024-01-01"]
    g["Revenues"]["units"]["USD"] = old
    g["RevenueFromContractWithCustomerExcludingAssessedTax"] = {"units": {"USD": new}}
    t = F.ttm(F.compact_facts(facts)["revenue"])
    assert t["end"] == "2024-12-31" and t["value"] == pytest.approx(560)


def test_ytd_cash_flow_ttm(facts):
    """SYNTHETIC: 10-Q cash flows are year-to-date, not quarterly."""
    q = lambda s, e, v, f: {"start": s, "end": e, "val": v, "filed": f, "form": "10-Q", "accn": "x"}  # noqa: E731
    facts["facts"]["us-gaap"]["NetCashProvidedByUsedInOperatingActivities"] = {"units": {"USD": [
        {"start": "2023-01-01", "end": "2023-12-31", "val": 100, "filed": "2024-02-15", "form": "10-K", "accn": "a"},
        q("2023-01-01", "2023-06-30", 40, "2023-08-01"), q("2024-01-01", "2024-06-30", 70, "2024-08-01")]}}
    t = F.ttm(F.compact_facts(facts)["ocf"])
    assert t["value"] == pytest.approx(100 + 70 - 40) and t["end"] == "2024-06-30" and "YTD" in t["basis"]


def test_bank_has_no_fcf(facts):
    snap = F.snapshot(F.compact_facts(facts))
    m = MET.compute(snap, price=30, splits=[], bars=bars_linear(n=300, p0=30), model="bank")
    assert m["fcf_yield"] is None and m["pe"] is not None


def test_13f_with_schema_location_parses():
    xml = fx("13f.xml").replace('<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">',
                                '<ns1:informationTable xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns1="http://www.sec.gov/x" xsi:schemaLocation="http://www.sec.gov/x x.xsd">').replace("</informationTable>", "</ns1:informationTable>")
    xml = xml.replace("<infoTable>", "<ns1:infoTable>").replace("</infoTable>", "</ns1:infoTable>")
    assert len(SEC.parse_13f_table(xml)) == 3


def test_zones_match_rules():
    from hoodstocks import zones as ZN
    import math
    c = [{"t": i, "o": 100, "h": 100 + 5 * math.sin(i / 3) + 2, "l": 100 + 5 * math.sin(i / 3) - 2, "c": 100 + 5 * math.sin(i / 3)} for i in range(80)]
    z = ZN.zones(100.0, c, c[-40:], runner=130)
    s = z["swing"]
    assert s["stop"] < s["entry"][0] <= 100 == s["entry"][1]
    assert s["tps"][0]["price"] > 100 and all(t["rr"] > 0 for t in s["tps"])
    assert s["tps"][-1]["price"] == 130 and s["tps"][-1]["label"] == "Runner"
    assert z["scalp"] and all(t["label"] != "Runner" for t in z["scalp"]["tps"])
    assert ZN.zones(100.0, [], None) is None
