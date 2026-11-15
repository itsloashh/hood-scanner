"""Call zones from price data — same rules as src/zones.js and dashboard/src/lib/zones.ts (keep in sync).

ATR(14) + 2-bar swing highs/lows: entry zone from the nearest support (within ~1 ATR) up to price, stop ½ ATR under that
support (kept 1–3 ATR below price), take-profits at the next resistances (else 2 and 4 ATR), a runner at the range high or
a model value, and a hold zone from the entry low to TP1. Swing = daily candles, scalp = hourly candles. Speculative."""
from __future__ import annotations

import time


def atr(c: list[dict], n: int = 14) -> float | None:
    if not c or len(c) < 2:
        return None
    tr = []
    for i in range(1, len(c)):
        h, l, pc = c[i]["h"], c[i]["l"], c[i - 1]["c"]
        if None in (h, l, pc):
            continue
        tr.append(max(h - l, abs(h - pc), abs(l - pc)))
    last = [x for x in tr[-n:] if x and x > 0]
    return sum(last) / len(last) if last else None


def pivots(c: list[dict], k: int = 2) -> tuple[list[float], list[float]]:
    highs, lows = [], []
    for i in range(k, len(c) - k):
        win = c[i - k:i + k + 1]
        if c[i]["h"] >= max(x["h"] for x in win):
            highs.append(c[i]["h"])
        if c[i]["l"] <= min(x["l"] for x in win):
            lows.append(c[i]["l"])
    return highs, lows


def _cluster(levels: list[float], gap: float) -> list[float]:
    out: list[float] = []
    for x in levels:
        if not any(abs(y - x) < gap for y in out):
            out.append(x)
    return out


def plan(c: list[dict] | None, price: float | None, *, max_stop_pct: float = 0.25, runner: float | None = None) -> dict | None:
    c = [x for x in (c or []) if x.get("h") is not None and x.get("l") is not None and x.get("c") is not None]
    if len(c) < 10 or not price:
        return None
    a = atr(c)
    if not a:
        return None
    highs, lows = pivots(c)
    supports = _cluster(sorted([x for x in lows if x < price], reverse=True), a * 0.5)
    resist = _cluster(sorted([x for x in highs if x > price * 1.002]), a * 0.5)
    sup = next((s for s in supports if price - s <= 1.25 * a), None)
    entry_low = max(sup, price - a) if sup is not None else price - 0.5 * a
    stop = (sup if sup is not None else entry_low) - 0.5 * a
    stop = min(stop, price - a)
    stop = max(stop, price - 3 * a, price * (1 - max_stop_pct))
    entry_mid = (entry_low + price) / 2
    tp1 = next((r for r in resist if r >= price + 0.8 * a), price + 2 * a)
    tp2 = next((r for r in resist if r >= tp1 + 0.8 * a), max(tp1 + 1.5 * a, price + 4 * a))
    range_high = max(x["h"] for x in c)
    tp3 = runner if runner and runner > tp2 * 1.02 else (range_high if range_high > tp2 * 1.02 else None)
    tps = [{"label": "TP1", "price": tp1, "why": "first resistance" if tp1 in resist else "2× normal move", "sell": 0.33},
           {"label": "TP2", "price": tp2, "why": "next resistance" if tp2 in resist else "4× normal move", "sell": 0.33}]
    if tp3:
        tps.append({"label": "Runner", "price": tp3, "why": "model value" if tp3 == runner else "top of the range", "sell": 0.34})
    for t in tps:
        t["rr"] = (t["price"] - entry_mid) / (entry_mid - stop) if entry_mid > stop else None
    return {"atr": a, "atr_pct": a / price, "entry": [entry_low, price], "stop": stop, "stop_pct": 1 - stop / price,
            "hold": [entry_low, tp1], "tps": tps, "support": sup, "resistances": resist[:4],
            "basis": "support + ATR" if sup is not None else "ATR only (no nearby support)"}


def zones(price: float | None, daily: list[dict] | None, hourly: list[dict] | None = None, runner: float | None = None) -> dict | None:
    swing = plan(daily[-260:] if daily else None, price, max_stop_pct=0.25, runner=runner)
    scalp = plan(hourly, price, max_stop_pct=0.08)
    if scalp:
        scalp["tps"] = [t for t in scalp["tps"] if t["label"] != "Runner"]
    if not swing and not scalp:
        return None
    return {"at": int(time.time() * 1000), "price": price, "swing": swing, "scalp": scalp,
            "note": "Levels from price data (ATR + swing highs/lows). Speculative — not advice."}
