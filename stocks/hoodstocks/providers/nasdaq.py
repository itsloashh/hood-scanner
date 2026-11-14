"""Nasdaq.com stock screener (one call → every US-listed stock with price, market cap, volume, sector).
Supplementary discovery list only; identity always comes from SEC. Unofficial endpoint."""
from __future__ import annotations

from ..http import Http

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def _money(s):
    if s in (None, "", "NA"):
        return None
    try:
        return float(str(s).replace("$", "").replace(",", ""))
    except ValueError:
        return None


def screener(http: Http) -> list[dict]:
    j = http.json("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&download=true", ua=UA, accept="application/json, text/plain, */*", cache_hours=12)
    out = []
    for r in j["data"]["rows"]:
        out.append({
            "ticker": (r.get("symbol") or "").strip().upper().replace("/", "-"),  # BRK/B → BRK-B (SEC style)
            "name": r.get("name"),
            "price": _money(r.get("lastsale")),
            "mcap": _money(r.get("marketCap")),
            "volume": _money(r.get("volume")),
            "country": r.get("country"),
            "sector": r.get("sector") or None,
            "industry": r.get("industry") or None,
            "ipo_year": r.get("ipoyear") or None,
        })
    return out
