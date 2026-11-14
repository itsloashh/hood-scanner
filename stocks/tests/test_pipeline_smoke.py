"""End-to-end smoke test of the daily pipeline against a fake network (SYNTHETIC responses only)."""
import json
import time
from datetime import date, timedelta

from conftest import bars_linear, fx
from hoodstocks import store


def _chart(sym, n=1300, p0=20.0, step=0.01, currency="USD", divs=None):
    bars = bars_linear(n=n, p0=p0, step=step, start=(date.today() - timedelta(days=int(n * 7 / 5) + 3)).isoformat())
    ts = [int(time.mktime(date.fromisoformat(b["t"]).timetuple())) + 43200 for b in bars]
    ev = {"dividends": {str(ts[-i]): {"amount": 0.25} for i in (10, 70, 130, 190)} if divs else {}}
    return {"chart": {"result": [{"meta": {"symbol": sym, "currency": currency, "regularMarketPrice": bars[-1]["c"], "longName": f"SYNTHETIC {sym}"},
                                  "timestamp": ts,
                                  "indicators": {"quote": [{"open": [b["c"] for b in bars], "high": [b["h"] for b in bars], "low": [b["l"] for b in bars],
                                                            "close": [b["c"] for b in bars], "volume": [b["v"] for b in bars]}],
                                                 "adjclose": [{"adjclose": [b["c"] for b in bars]}]}, "events": ev}]}}


def fake_net(facts):
    today = date.today()
    sub = lambda cik, name, sic, state: {  # noqa: E731
        "cik": cik, "name": name, "sic": str(sic), "sicDescription": "x", "stateOfIncorporation": "DE",
        "addresses": {"business": {"stateOrCountry": state}}, "tickers": [], "exchanges": [],
        "filings": {"recent": {"form": ["10-Q", "8-K", "4"], "filingDate": [(today - timedelta(days=d)).isoformat() for d in (20, 1, 2)],
                               "reportDate": ["", "", ""], "accessionNumber": ["0000000001-26-000010", "0000000001-26-000011", "0000000009-26-000001"],
                               "primaryDocument": ["q.htm", "k.htm", "f4.xml"], "items": ["", "1.01,9.01", ""]}}}

    def transport(url, headers, data):
        j = None
        if "api.nasdaq.com" in url:
            j = {"data": {"rows": [{"symbol": "SYN", "name": "Syn", "lastsale": "$33.00", "marketCap": "3300000000", "volume": "1000000",
                                    "country": "United States", "sector": "Technology", "industry": "Software"},
                                   {"symbol": "MPL", "name": "Maple", "lastsale": "$33.00", "marketCap": "3300000000", "volume": "1000000",
                                    "country": "Canada", "sector": "Finance", "industry": "Banks"}]}}
        elif "company_tickers_exchange" in url:
            j = {"fields": ["cik", "name", "ticker", "exchange"], "data": [[1, "Synthetic Co", "SYN", "NYSE"], [2, "Maple Bank", "MPL", "NYSE"]]}
        elif "/submissions/CIK0000000001" in url:
            j = sub(1, "Synthetic Co", 7372, "CA")
        elif "/submissions/CIK0000000002" in url:
            j = sub(2, "Maple Bank", 6022, "A6")
        elif "/submissions/" in url:
            return 404, b""
        elif "companyfacts" in url:
            j = facts
        elif "daily-index" in url:
            return 200, fx("form.idx").replace("20261113", today.strftime("%Y%m%d")).encode()
        elif "Archives/edgar/data/1/0000000009-26-000001.txt" in url:
            return 200, fx("form4.xml").replace("2026-11-02", (today - timedelta(days=2)).isoformat()).encode()
        elif "finance.yahoo.com" in url:
            sym = url.split("/chart/")[1].split("?")[0]
            if sym == "MPL.TO":
                j = _chart(sym, p0=44.0, currency="CAD", step=0.014)
            else:
                j = _chart(sym, divs=sym in ("SYN", "SCHD"))
        elif "fredgraph" in url:
            rows = "\n".join(f"{(today - timedelta(days=i)).isoformat()},{4 + i / 100}" for i in range(400, 0, -1))
            return 200, ("observation_date,X\n" + rows).encode()
        elif "bankofcanada" in url:
            j = {"observations": [{"d": (today - timedelta(days=i)).isoformat(), "V39079": {"v": "2.75"}, "FXUSDCAD": {"v": "1.38"}} for i in range(30, 0, -1)]}
        elif "telegram" in url:
            j = {"ok": True}
        else:
            return 404, b""
        return 200, json.dumps(j).encode()

    return transport


def test_daily_pipeline_end_to_end(facts, monkeypatch):
    from hoodstocks import pipeline, run
    for r in facts["facts"]["dei"]["EntityCommonStockSharesOutstanding"]["units"]["shares"]:
        r["val"] = 1e8  # → ~$3B market cap
    for c in facts["facts"]["us-gaap"].values():
        for r in c["units"]["USD"]:
            r["val"] *= 1e6
    monkeypatch.setattr("time.sleep", lambda s: None)
    orig = pipeline.Ctx.__init__

    def init(self, budget_min=100):
        orig(self, budget_min)
        self.http.transport = fake_net(facts)
        self.http.cache_dir = None

    monkeypatch.setattr(pipeline.Ctx, "__init__", init)
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "")
    run.main(["daily"])
    h = store.read("health.json")
    assert h["error"] is None, h
    bad = {k: v for k, v in h["stages"].items() if not v["ok"]}
    assert not bad, bad
    uni = store.read("universe.json")
    ids = {r["id"] for r in uni["rows"]}
    assert "SEC1" in ids
    d = store.read("sec/SEC1.json")
    assert d["row"]["verified"] and d["insider"]["buys"], d["insider"]
    assert d["sources"][0]["reliability"] == "primary"
    assert any(e["item"] == "1.01" for e in d["events"])
    maple = store.read("master.json")["SEC2"]
    assert maple["country"] == "CA"
    assert store.read("opportunities.json")["etfs"]
    assert store.read("macro.json")["readings"]["DGS10"]["last"] is not None
    # second run: nothing new → no duplicate discoveries
    n = len(store.read_lines("candidates.jsonl"))
    run.main(["daily"])
    assert len(store.read_lines("candidates.jsonl")) == n
    run.main(["insiders"])
    assert store.read("health-insiders.json")["error"] is None
