"""Probe the free data sources from GitHub Actions and save short samples (no secrets)."""
import json, os, time, urllib.request, urllib.error

UA = os.environ.get("SEC_USER_AGENT") or "HoodDesk research bot (github.com/itsloashh/hood-scanner)"
OUT = "data/stocks/probe"
os.makedirs(OUT, exist_ok=True)
BROWSER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def get(url, ua=None, accept="application/json", data=None, headers=None):
    h = {"User-Agent": ua or UA, "Accept": accept, "Accept-Encoding": "identity"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h)
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read(), round(time.time() - t, 2)
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:500], round(time.time() - t, 2)
    except Exception as e:
        return 0, str(e).encode(), round(time.time() - t, 2)


checks = {
    "sec_tickers": ("https://www.sec.gov/files/company_tickers_exchange.json", None),
    "sec_submissions": ("https://data.sec.gov/submissions/CIK0000320193.json", None),
    "sec_facts": ("https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json", None),
    "sec_frames": ("https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/CY2025Q2I.json", None),
    "sec_daily_index": ("https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/", None),
    "sec_current_form4": ("https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&owner=only&count=40&output=atom", None),
    "sec_facts_ca": ("https://data.sec.gov/api/xbrl/companyfacts/CIK0001000275.json", None),
    "yahoo_chart": ("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5y&interval=1d&events=div%2Csplits", BROWSER),
    "yahoo_chart_tsx": ("https://query1.finance.yahoo.com/v8/finance/chart/RY.TO?range=1y&interval=1d&events=div", BROWSER),
    "yahoo_spark": ("https://query1.finance.yahoo.com/v7/finance/spark?symbols=AAPL,MSFT,RY.TO,SHOP.TO&range=5d&interval=1d", BROWSER),
    "fred_csv": ("https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2", BROWSER),
    "boc_valet": ("https://www.bankofcanada.ca/valet/observations/V39079,FXUSDCAD/json?recent=5", None),
    "gnews": ("https://news.google.com/rss/search?q=%22AAPL%22+stock&hl=en-US&gl=US&ceid=US:en", BROWSER),
    "house_ptr_index": ("https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip", BROWSER),
    "tmx_directory": ("https://www.tsx.com/json/company-directory/search/tsx/A", BROWSER),
    "nasdaq_screener": ("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=5&download=true", BROWSER),
}
res = {}
for k, (u, ua) in checks.items():
    s, b, dt = get(u, ua)
    res[k] = {"status": s, "bytes": len(b), "sec": dt, "sample": b[:1500].decode("utf-8", "replace")}
    print(k, s, len(b), dt)
    time.sleep(0.3)
s, b, dt = get("https://api.openfigi.com/v3/mapping", data=json.dumps([{"idType": "ID_CUSIP", "idValue": "037833100"}]).encode(), headers={"Content-Type": "application/json"})
res["openfigi"] = {"status": s, "bytes": len(b), "sec": dt, "sample": b[:800].decode("utf-8", "replace")}
s, b, dt = get("https://data.sec.gov/submissions/CIK0001067983.json")
res["sec_13f_filer"] = {"status": s, "bytes": len(b), "sec": dt}
if s == 200:
    r = json.loads(b)["filings"]["recent"]
    idx = [i for i, f in enumerate(r["form"]) if f == "13F-HR"][:2]
    res["sec_13f_filer"]["recent"] = [(r["accessionNumber"][i], r["reportDate"][i], r["filingDate"][i], r["primaryDocument"][i]) for i in idx]
    if idx:
        acc = r["accessionNumber"][idx[0]].replace("-", "")
        s2, b2, _ = get(f"https://www.sec.gov/Archives/edgar/data/1067983/{acc}/index.json")
        res["sec_13f_index"] = {"status": s2, "sample": b2[:2000].decode("utf-8", "replace")}
json.dump(res, open(f"{OUT}/probe.json", "w"), indent=1)
