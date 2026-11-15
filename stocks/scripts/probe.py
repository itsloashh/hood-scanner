"""Probe options + earnings sources from GitHub Actions (no secrets). Writes data/stocks/probe/probe.json."""
import json, os, time, urllib.request, urllib.error
from datetime import date, timedelta

OUT = "data/stocks/probe"
os.makedirs(OUT, exist_ok=True)
BOT = "Mozilla/5.0 (compatible; hood-desk-stocks/1.0; +github.com/itsloashh/hood-scanner)"
BROWSER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def get(url, ua, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "application/json, text/plain, */*"})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), round(time.time() - t, 2)
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300], round(time.time() - t, 2)
    except Exception as e:
        return 0, str(e).encode(), round(time.time() - t, 2)


res = {}
for k, u, ua in [
    ("cboe_aapl", "https://cdn.cboe.com/api/global/delayed_quotes/options/AAPL.json", BOT),
    ("cboe_aapl_browser", "https://cdn.cboe.com/api/global/delayed_quotes/options/AAPL.json", BROWSER),
    ("cboe_quote", "https://cdn.cboe.com/api/global/delayed_quotes/quotes/AAPL.json", BOT),
    ("nasdaq_earn", f"https://api.nasdaq.com/api/calendar/earnings?date={(date.today() + timedelta(days=1)).isoformat()}", BROWSER),
    ("nasdaq_opt", "https://api.nasdaq.com/api/quote/AAPL/option-chain?assetclass=stocks&limit=5", BROWSER),
    ("yahoo_opt", "https://query1.finance.yahoo.com/v7/finance/options/AAPL", BOT),
]:
    s, b, dt = get(u, ua)
    r = {"status": s, "bytes": len(b), "sec": dt}
    try:
        j = json.loads(b)
        if k.startswith("cboe") and s == 200:
            d = j.get("data", {})
            r["keys"] = list(d.keys())
            r["scalar"] = {kk: vv for kk, vv in d.items() if not isinstance(vv, (list, dict))}
            opts = d.get("options") or []
            r["n_options"] = len(opts)
            r["sample"] = opts[:3]
            r["timestamp"] = j.get("timestamp")
        elif k == "nasdaq_earn" and s == 200:
            rows = ((j.get("data") or {}).get("rows") or [])
            r["n"] = len(rows)
            r["sample"] = rows[:2]
        else:
            r["sample"] = str(j)[:600]
    except Exception:
        r["sample"] = b[:300].decode("utf-8", "replace")
    res[k] = r
    print(k, s, len(b), dt)
    time.sleep(0.5)
json.dump(res, open(f"{OUT}/probe.json", "w"), indent=1, default=str)
