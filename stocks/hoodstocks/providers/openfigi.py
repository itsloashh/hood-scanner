"""OpenFIGI: CUSIP → ticker for 13F holdings. Results cached forever (identifiers don't change)."""
from __future__ import annotations

import json
import os

from ..http import Http


def map_cusips(http: Http, cusips: list[str], cache: dict) -> dict:
    """cache: {cusip: {ticker, name, exch, figi} | None}. Mutates and returns it."""
    todo = [c for c in dict.fromkeys(cusips) if c and c not in cache]
    key = os.environ.get("OPENFIGI_API_KEY")
    batch = 100 if key else 10
    for i in range(0, len(todo), batch):
        chunk = todo[i:i + batch]
        body = json.dumps([{"idType": "ID_CUSIP", "idValue": c, "exchCode": "US"} for c in chunk]).encode()
        headers = {"X-OPENFIGI-APIKEY": key} if key else {}
        try:
            res = http.json("https://api.openfigi.com/v3/mapping", data=body, headers=headers)
        except Exception:
            break  # keep what we have; the rest maps next run
        for c, r in zip(chunk, res):
            d = (r.get("data") or [None])[0]
            cache[c] = {"ticker": d.get("ticker"), "name": d.get("name"), "figi": d.get("compositeFIGI") or d.get("figi"), "type": d.get("securityType")} if d else None
    return cache
