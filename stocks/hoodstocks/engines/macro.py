"""Macro engine: classify each economic series (positive / negative / neutral / uncertain for equities),
map to sector impacts, and measure sector rotation from relative performance + breadth (never inferring flows from price)."""
from __future__ import annotations

from datetime import date, timedelta

# How a RISE in each series tends to read for broad equities, and which sectors it helps (+) or hurts (−)
RULES = {
    "DFF": ("negative", {"Financials": +1, "Real Estate": -1, "Utilities": -1, "Technology": -1}),
    "CPIAUCSL": ("negative", {"Energy": +1, "Materials": +1, "Consumer Discretionary": -1}),
    "PCEPILFE": ("negative", {"Consumer Discretionary": -1}),
    "UNRATE": ("negative", {"Consumer Discretionary": -1, "Financials": -1, "Consumer Staples": +1, "Utilities": +1}),
    "GDPC1": ("positive", {"Industrials": +1, "Materials": +1, "Consumer Discretionary": +1, "Financials": +1}),
    "DGS10": ("negative", {"Real Estate": -1, "Utilities": -1, "Financials": +1, "Technology": -1}),
    "DGS2": ("negative", {"Financials": +1, "Real Estate": -1}),
    "T10Y2Y": ("positive", {"Financials": +1}),
    "BAMLH0A0HYM2": ("negative", {"Financials": -1, "Consumer Discretionary": -1, "Industrials": -1, "Consumer Staples": +1, "Utilities": +1}),
    "DCOILWTICO": ("neutral", {"Energy": +1, "Industrials": -1, "Consumer Discretionary": -1}),
    "DHHNGSP": ("neutral", {"Energy": +1, "Utilities": -1}),
    "PCOPPUSDM": ("positive", {"Materials": +1, "Industrials": +1}),
    "DEXCAUS": ("neutral", {}),
    "IPMAN": ("positive", {"Industrials": +1, "Materials": +1}),
    "V39079": ("negative", {"Financials": +1, "Real Estate": -1, "Utilities": -1}),
}
# Change that counts as meaningful (absolute for rates/%, relative for levels)
THRESH = {"DFF": 0.2, "DGS10": 0.25, "DGS2": 0.25, "T10Y2Y": 0.2, "BAMLH0A0HYM2": 0.4, "UNRATE": 0.2, "V39079": 0.2}


def change(series: list[tuple[str, float]], days: int) -> tuple[float | None, float | None, str | None]:
    if not series:
        return None, None, None
    last_d, last = series[-1]
    target = (date.fromisoformat(last_d) - timedelta(days=days)).isoformat()
    prev = [v for d, v in series if d <= target]
    if not prev:
        return last, None, last_d
    return last, last - prev[-1], last_d


def classify(sid: str, series: list[tuple[str, float]], stale_days: int) -> dict:
    lookback = 95 if sid in ("GDPC1",) else 35 if sid in ("CPIAUCSL", "PCEPILFE", "UNRATE", "IPMAN", "PCOPPUSDM") else 30
    last, delta, last_d = change(series, lookback)
    if last is None:
        return {"status": "unavailable"}
    stale = (date.today() - date.fromisoformat(last_d)).days > stale_days
    tone, sectors = RULES.get(sid, ("neutral", {}))
    if delta is None:
        direction = "flat"
    else:
        th = THRESH.get(sid)
        rel = delta / abs(last - delta) if (last - delta) else 0
        moved = abs(delta) >= th if th else abs(rel) >= (0.005 if sid in ("CPIAUCSL", "PCEPILFE", "GDPC1") else 0.05)
        direction = "up" if moved and delta > 0 else "down" if moved and delta < 0 else "flat"
    if stale:
        reading = "uncertain"
    elif direction == "flat" or tone == "neutral":
        reading = "neutral"
    else:
        good = (direction == "up") == (tone == "positive")
        reading = "positive" if good else "negative"
    if sid in ("CPIAUCSL", "PCEPILFE") and len(series) > 13:
        yoy = series[-1][1] / series[-13][1] - 1
    else:
        yoy = None
    impacts = {s: (w if direction == "up" else -w) for s, w in sectors.items()} if direction != "flat" and not stale else {}
    return {"last": last, "date": last_d, "change": delta, "lookback_days": lookback, "direction": direction, "reading": reading,
            "stale": stale, "yoy": yoy, "sector_impacts": impacts}


def sector_tilt(readings: dict) -> dict[str, int]:
    tilt: dict[str, int] = {}
    for r in readings.values():
        for s, w in (r.get("sector_impacts") or {}).items():
            tilt[s] = tilt.get(s, 0) + w
    return tilt


def rotation(sector_px: dict[str, dict], bench: dict, breadth: dict[str, float]) -> dict[str, dict]:
    """sector_px: sector -> price stats of its ETF. Relative strength vs SPY over 1m/3m + % of our universe above 50-day avg."""
    out = {}
    for s, px in sector_px.items():
        r1 = (px.get("ret_1m") or 0) - (bench.get("ret_1m") or 0)
        r3 = (px.get("ret_3m") or 0) - (bench.get("ret_3m") or 0)
        b = breadth.get(s)
        state = "leading" if r1 > 0 and r3 > 0 else "improving" if r1 > 0 >= r3 else "weakening" if r3 > 0 >= r1 else "lagging"
        out[s] = {"rel_1m": r1, "rel_3m": r3, "breadth_above_ma50": b, "rel_volume": px.get("rel_volume"), "state": state}
    return out
