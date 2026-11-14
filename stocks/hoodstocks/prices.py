"""Price-derived numbers (deterministic). Bars: [{t, o, h, l, c, v, adj}] oldest → newest, split-adjusted closes."""
from __future__ import annotations

import math
from bisect import bisect_right
from datetime import date, datetime


def _d(s: str) -> date:
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def stats(bars: list[dict], as_of: str | None = None) -> dict:
    if as_of:
        bars = [b for b in bars if b["t"] <= as_of]
    if not bars:
        return {"days": 0}
    closes = [b["c"] for b in bars]
    last = bars[-1]
    yr = bars[-252:]
    hi52 = max(b["h"] or b["c"] for b in yr)
    lo52 = min(b["l"] or b["c"] for b in yr)
    dv = [b["c"] * (b["v"] or 0) for b in bars[-50:]]
    rets = [math.log(bars[i]["adj"] / bars[i - 1]["adj"]) for i in range(max(1, len(bars) - 252), len(bars)) if bars[i - 1]["adj"] and bars[i]["adj"]]
    vol = (sum((r - sum(rets) / len(rets)) ** 2 for r in rets) / max(1, len(rets) - 1)) ** 0.5 * math.sqrt(252) if len(rets) > 20 else None

    def chg(n):
        return (bars[-1]["adj"] / bars[-1 - n]["adj"] - 1) if len(bars) > n and bars[-1 - n]["adj"] else None

    def ma(n):
        return sum(closes[-n:]) / n if len(closes) >= n else None

    vol20 = sum(b["v"] or 0 for b in bars[-20:]) / max(1, len(bars[-20:]))
    vol90 = sum(b["v"] or 0 for b in bars[-90:]) / max(1, len(bars[-90:]))
    return {
        "days": len(bars),
        "last": last["c"],
        "last_date": last["t"],
        "high_52w": hi52,
        "low_52w": lo52,
        "off_high": 1 - last["c"] / hi52 if hi52 else None,
        "adv_usd_50": sum(dv) / len(dv) if dv else 0,
        "ret_1m": chg(21), "ret_3m": chg(63), "ret_6m": chg(126), "ret_1y": chg(252),
        "ma50": ma(50), "ma200": ma(200),
        "above_ma50": last["c"] > ma(50) if ma(50) else None,
        "above_ma200": last["c"] > ma(200) if ma(200) else None,
        "vol_1y": vol,
        "rel_volume": vol20 / vol90 if vol90 else None,
        "max_dd_1y": max_drawdown([b["adj"] for b in yr]),
    }


def max_drawdown(series: list[float]) -> float | None:
    if not series:
        return None
    peak, mdd = series[0], 0.0
    for v in series:
        if v is None:
            continue
        peak = max(peak, v)
        if peak:
            mdd = max(mdd, 1 - v / peak)
    return mdd


def close_on(bars: list[dict], day: str, adj: bool = False) -> float | None:
    """Last close on or before `day` (point-in-time)."""
    ts = [b["t"] for b in bars]
    i = bisect_right(ts, day[:10]) - 1
    if i < 0:
        return None
    return bars[i]["adj" if adj else "c"]


def split_factor_after(splits: list[dict], day: str) -> float:
    """Multiply a share count reported on `day` by this to express it in today's shares."""
    f = 1.0
    for s in splits:
        if s["date"] > day[:10] and s.get("ratio"):
            f *= s["ratio"]
    return f


def forward_return(bars: list[dict], start: str, days: int, adj: bool = True) -> float | None:
    """Return from the close on/before `start` to the close `days` calendar days later (None if not reached yet)."""
    p0 = close_on(bars, start, adj)
    end = date.fromordinal(_d(start).toordinal() + days).isoformat()
    if not bars or bars[-1]["t"] < end or p0 is None:
        return None
    p1 = close_on(bars, end, adj)
    return p1 / p0 - 1 if p0 and p1 else None


def path_drawdown(bars: list[dict], start: str, adj: bool = True) -> float | None:
    seg = [b["adj" if adj else "c"] for b in bars if b["t"] >= start[:10]]
    return max_drawdown(seg)


def merge_bars(old: list[dict], new: list[dict]) -> list[dict]:
    """Merge a short recent fetch into a long cached series. If adjusted values diverge (new split/dividend), the caller refetches."""
    m = {b["t"]: b for b in old}
    for b in new:
        m[b["t"]] = b
    return [m[k] for k in sorted(m)]


def needs_refetch(old: list[dict], new: list[dict]) -> bool:
    """A split or dividend changes historical adjusted values; detect by comparing an overlapping bar."""
    om = {b["t"]: b for b in old}
    for b in new[:3]:
        o = om.get(b["t"])
        if o and o["c"] and abs(o["c"] - b["c"]) / o["c"] > 0.002:
            return True
    return False
