"""Probe the free data sources from GitHub Actions and save short samples (no secrets)."""
import json, os, time, urllib.request, urllib.error

OUT = "data/stocks/probe"
os.makedirs(OUT, exist_ok=True)
BOT = "Mozilla/5.0 (compatible; hood-desk-stocks/1.0; +github.com/itsloashh/hood-scanner)"


def get(url, ua, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "*/*"})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), round(time.time() - t, 2)
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300], round(time.time() - t, 2)
    except Exception as e:
        return 0, str(e).encode(), round(time.time() - t, 2)


res = {}
sec_uas = {
    "secret": os.environ.get("SEC_USER_AGENT") or "",
    "bot": BOT,
    "plain": "HoodDesk Research hood-desk-stocks",
    "python": "Python-urllib/3.12",
}
for name, ua in sec_uas.items():
    if not ua:
        continue
    s, b, dt = get("https://data.sec.gov/submissions/CIK0000320193.json", ua)
    res[f"sec_ua_{name}"] = {"status": s, "bytes": len(b), "sec": dt}
    s, b, dt = get("https://www.sec.gov/files/company_tickers_exchange.json", ua)
    res[f"sec_www_ua_{name}"] = {"status": s, "bytes": len(b), "sec": dt}
    time.sleep(1)
for k, u in {
    "yahoo_chart": "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5y&interval=1d&events=div%2Csplits",
    "yahoo_chart_tsx": "https://query1.finance.yahoo.com/v8/finance/chart/RY.TO?range=1y&interval=1d&events=div",
    "yahoo_spark": "https://query1.finance.yahoo.com/v7/finance/spark?symbols=AAPL,MSFT,RY.TO,SHOP.TO&range=5d&interval=1d",
    "fred_csv": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2",
}.items():
    s, b, dt = get(u, BOT)
    res[k] = {"status": s, "bytes": len(b), "sec": dt, "sample": b[:300].decode("utf-8", "replace")}
    time.sleep(0.5)
s, b, dt = get("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&download=true", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36")
if s == 200:
    j = json.loads(b)
    rows = j["data"]["rows"]
    res["nasdaq_screener"] = {"status": s, "n": len(rows), "keys": list(rows[0].keys()), "sample": rows[:2]}
s, b, dt = get("https://www.tsx.com/json/company-directory/search/tsx/A", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36")
res["tmx"] = {"status": s, "sample": b[:600].decode("utf-8", "replace")}
json.dump(res, open(f"{OUT}/probe.json", "w"), indent=1)
for k, v in res.items():
    print(k, v.get("status"), v.get("bytes"), v.get("sec"))
