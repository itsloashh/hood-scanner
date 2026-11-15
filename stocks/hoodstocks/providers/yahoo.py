"""Yahoo Finance chart API — supplementary, delayed daily prices with dividends and splits.
Unofficial and unlicensed for redistribution: used for personal research, labelled delayed everywhere."""
from __future__ import annotations

import urllib.parse
from datetime import datetime, timezone

from ..http import FetchError, Http

UA = "Mozilla/5.0 (compatible; hood-desk-stocks/1.0; +github.com/itsloashh/hood-scanner)"


def parse_chart(j: dict, intraday: bool = False) -> dict | None:
    r = (j.get("chart") or {}).get("result") or []
    if not r:
        return None
    r = r[0]
    meta = r.get("meta", {})
    ts = r.get("timestamp") or []
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    adj = ((r.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose")
    bars = []
    for i, t in enumerate(ts):
        c = (q.get("close") or [None])[i] if i < len(q.get("close") or []) else None
        if c is None:
            continue
        bars.append({
            "t": datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d") if intraday is False else datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M"),
            "o": (q.get("open") or [None])[i], "h": (q.get("high") or [None])[i], "l": (q.get("low") or [None])[i],
            "c": c, "v": (q.get("volume") or [0])[i] or 0,
            "adj": adj[i] if adj and i < len(adj) and adj[i] is not None else c,
        })
    ev = r.get("events") or {}
    divs = sorted(({"ex_date": datetime.fromtimestamp(int(k), timezone.utc).strftime("%Y-%m-%d"), "amount": v.get("amount")} for k, v in (ev.get("dividends") or {}).items()), key=lambda d: d["ex_date"])
    splits = sorted(({"date": datetime.fromtimestamp(int(k), timezone.utc).strftime("%Y-%m-%d"), "ratio": (v.get("numerator") or 1) / (v.get("denominator") or 1)} for k, v in (ev.get("splits") or {}).items()), key=lambda d: d["date"])
    return {
        "symbol": meta.get("symbol"),
        "currency": meta.get("currency"),
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
        "instrument": meta.get("instrumentType"),
        "name": meta.get("longName") or meta.get("shortName"),
        "first_trade": datetime.fromtimestamp(meta["firstTradeDate"], timezone.utc).strftime("%Y-%m-%d") if meta.get("firstTradeDate") else None,
        "price": meta.get("regularMarketPrice"),
        "price_time": datetime.fromtimestamp(meta["regularMarketTime"], timezone.utc).isoformat() if meta.get("regularMarketTime") else None,
        "bars": bars,
        "dividends": divs,
        "splits": splits,
    }


class Yahoo:
    def __init__(self, http: Http):
        self.http = http

    def chart(self, symbol: str, range_: str = "5y", cache_hours: float = 12, interval: str = "1d") -> dict | None:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?range={range_}&interval={interval}&events=div%2Csplits&includeAdjustedClose=true"
        try:
            return parse_chart(self.http.json(url, ua=UA, accept="*/*", cache_hours=cache_hours), intraday=interval != "1d")
        except FetchError as e:
            if e.status == 404:
                return None
            raise
