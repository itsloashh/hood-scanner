"""Options layer: turns high-quality stock candidates into concrete CALL setups (bullish only, V1).

Data: Cboe delayed option chains (free, ~15 min delayed, with IV/greeks/open interest) and the Nasdaq earnings calendar.
Nothing here is a recommendation — every setup is a research candidate with its assumptions shown.

How a setup is built
  1. Stock gate      quality score, evidence, swing zones with reward/risk, and timing (uptrend, not stretched, RSI healthy)
  2. Expiry          30–60 days to expiry, closest to 45; earnings inside the window are flagged
  3. Liquidity       open interest, a bid, and a tight bid/ask spread on every leg
  4. Volatility      at-the-money IV vs the stock's own realised volatility (IV/HV); IV history stored to build IV rank
  5. Structure       cheap options → buy the ~0.60-delta call; expensive options or earnings in the window → call debit spread
                     (buy ~0.60 delta, sell the strike nearest TP2)
  6. Payoff          Black-Scholes value of the position if price reaches TP1 / TP2 or the stop halfway to expiry
  7. Tier            A / B / C from points (shown with every reason); only A and B are alerted
"""
from __future__ import annotations

import math
import re
from datetime import date, datetime, timedelta, timezone

from . import store

CBOE = "https://cdn.cboe.com/api/global/delayed_quotes/options/{sym}.json"
NASDAQ_EARN = "https://api.nasdaq.com/api/calendar/earnings?date={d}"
BROWSER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

CFG = {
    "min_score": 55, "min_confidence": 70, "min_mcap": 1e9, "min_tp1_rr": 1.2,
    "dte": (30, 60), "dte_target": 45, "exit_dte": 21,
    "long_delta": 0.60, "long_delta_band": (0.45, 0.75),
    "min_oi": 300, "max_spread_pct": 0.12,
    "cheap_iv_ratio": 1.15, "expensive_iv_ratio": 1.4,
    "tiers": {"A": 9.0, "B": 7.0, "C": 5.0},
    "max_chains": 60, "alert_cooldown_days": 14, "max_alerts_per_run": 3,
    "take_profit_pct": {"call": 1.0, "spread": 0.8},  # long call +100%, spread 80% of max value
}

OCC = re.compile(r"^(?P<root>.+?)(?P<y>\d{2})(?P<m>\d{2})(?P<d>\d{2})(?P<cp>[CP])(?P<k>\d{8})$")


# ── math ─────────────────────────────────────────────────
def _ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_call(s: float, k: float, t: float, sigma: float, r: float = 0.04) -> float:
    """Black-Scholes call value. t in years."""
    if t <= 0 or sigma <= 0:
        return max(0.0, s - k)
    d1 = (math.log(s / k) + (r + sigma * sigma / 2) * t) / (sigma * math.sqrt(t))
    d2 = d1 - sigma * math.sqrt(t)
    return s * _ncdf(d1) - k * math.exp(-r * t) * _ncdf(d2)


def realised_vol(bars: list[dict], n: int) -> float | None:
    closes = [b["c"] for b in bars[-(n + 1):] if b.get("c")]
    if len(closes) < n // 2:
        return None
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes)) if closes[i - 1] > 0]
    if len(rets) < 5:
        return None
    m = sum(rets) / len(rets)
    return (sum((x - m) ** 2 for x in rets) / (len(rets) - 1)) ** 0.5 * math.sqrt(252)


def rsi(bars: list[dict], n: int = 14) -> float | None:
    c = [b["c"] for b in bars[-(n * 3):] if b.get("c")]
    if len(c) <= n:
        return None
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = c[i] - c[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    ag, al = gains / n, losses / n
    for i in range(n + 1, len(c)):
        d = c[i] - c[i - 1]
        ag = (ag * (n - 1) + max(d, 0)) / n
        al = (al * (n - 1) + max(-d, 0)) / n
    return 100.0 if al == 0 else 100 - 100 / (1 + ag / al)


def sma(bars: list[dict], n: int) -> float | None:
    c = [b["c"] for b in bars[-n:]]
    return sum(c) / n if len(c) == n else None


# ── data ─────────────────────────────────────────────────
def parse_chain(j: dict) -> dict:
    d = j.get("data") or {}
    calls = []
    for o in d.get("options") or []:
        m = OCC.match(o.get("option") or "")
        if not m or m["cp"] != "C":
            continue
        calls.append({
            "symbol": o["option"], "expiry": f"20{m['y']}-{m['m']}-{m['d']}", "strike": int(m["k"]) / 1000,
            "bid": o.get("bid") or 0.0, "ask": o.get("ask") or 0.0, "iv": o.get("iv") or 0.0, "delta": o.get("delta") or 0.0,
            "theta": o.get("theta") or 0.0, "vega": o.get("vega") or 0.0, "oi": o.get("open_interest") or 0.0,
            "volume": o.get("volume") or 0.0, "last": o.get("last_trade_price"),
        })
    return {"spot": d.get("current_price") or d.get("close"), "iv30": d.get("iv30"), "as_of": j.get("timestamp") or d.get("last_trade_time"), "calls": calls}


def fetch_chain(http, sym: str) -> dict | None:
    try:
        return parse_chain(http.json(CBOE.format(sym=sym.replace("-", ".").upper()), ua=BROWSER, accept="application/json", cache_hours=0))
    except Exception:
        return None


def earnings_calendar(http, days: int = 70) -> dict[str, str]:
    """ticker → next earnings date (YYYY-MM-DD) within `days`. Cached in data/stocks/options/earnings.json for 20h."""
    cached = store.read("options/earnings.json", {}) or {}
    if cached.get("_fetched", "") >= (datetime.now(timezone.utc) - timedelta(hours=20)).isoformat():
        return cached.get("dates", {})
    out: dict[str, str] = {}
    d = date.today()
    for i in range(days):
        day = d + timedelta(days=i)
        if day.weekday() >= 5:
            continue
        try:
            j = http.json(NASDAQ_EARN.format(d=day.isoformat()), ua=BROWSER, accept="application/json, text/plain, */*", cache_hours=20)
        except Exception:
            continue
        for r in ((j.get("data") or {}).get("rows") or []):
            t = (r.get("symbol") or "").upper().replace("/", "-")
            if t and t not in out:
                out[t] = day.isoformat()
    store.write("options/earnings.json", {"_fetched": datetime.now(timezone.utc).isoformat(), "dates": out}, compact=True)
    return out


# ── selection ────────────────────────────────────────────
def mid(c: dict) -> float:
    return (c["bid"] + c["ask"]) / 2 if c["bid"] and c["ask"] else c["ask"] or c["bid"]


def spread_pct(c: dict) -> float:
    m = mid(c)
    return (c["ask"] - c["bid"]) / m if m else 1.0


def liquid(c: dict) -> bool:
    return c["bid"] > 0 and c["oi"] >= CFG["min_oi"] and spread_pct(c) <= CFG["max_spread_pct"]


def pick_expiry(calls: list[dict], today: date) -> tuple[str, int] | None:
    exps = sorted({c["expiry"] for c in calls})
    lo, hi = CFG["dte"]
    ok = [(e, (date.fromisoformat(e) - today).days) for e in exps]
    ok = [(e, n) for e, n in ok if lo <= n <= hi]
    if not ok:
        return None
    return min(ok, key=lambda x: abs(x[1] - CFG["dte_target"]))


def timing(bars: list[dict], price: float, zones: dict) -> dict:
    s = (zones or {}).get("swing") or {}
    ma50, ma200 = sma(bars, 50), sma(bars, 200)
    r = rsi(bars)
    atr = s.get("atr")
    entry = s.get("entry") or [None, None]
    out = {"ma50": ma50, "ma200": ma200, "rsi": r, "uptrend": bool(ma50 and ma200 and price > ma50 and ma50 >= ma200 * 0.98),
           "above_ma50": bool(ma50 and price > ma50)}
    out["in_zone"] = bool(entry[0] and entry[0] <= price <= (entry[1] or price) * 1.005)
    out["extended"] = bool(atr and entry[1] and price > entry[1] + 0.75 * atr)
    out["rsi_ok"] = bool(r is not None and 45 <= r <= 70)
    m1 = (price / bars[-22]["c"] - 1) if len(bars) > 22 and bars[-22]["c"] else None
    out["ret_1m"] = m1
    return out


def project(legs: list[tuple[dict, int]], s: float, t_years: float, r: float) -> float:
    """Value of a position (per share) at price s with t_years left, using each leg's own IV."""
    return sum(q * bs_call(s, c["strike"], t_years, max(c["iv"], 0.05), r) for c, q in legs)


def build_setup(row: dict, detail: dict, chain: dict, bars: list[dict], earnings: str | None, rate: float, today: date | None = None) -> dict | None:
    today = today or date.today()
    zones = detail.get("zones") or {}
    sw = zones.get("swing")
    if not sw or not chain or not chain.get("calls"):
        return None
    spot = chain.get("spot") or row["price"]
    tps = sw["tps"]
    tp1 = tps[0]["price"]
    tp2 = tps[1]["price"] if len(tps) > 1 else tp1
    stop = sw["stop"]
    ex = pick_expiry(chain["calls"], today)
    if not ex:
        return None
    expiry, dte = ex
    calls = sorted([c for c in chain["calls"] if c["expiry"] == expiry], key=lambda c: c["strike"])
    if not calls:
        return None
    atm = min(calls, key=lambda c: abs(c["strike"] - spot))
    atm_iv = atm["iv"] or (chain.get("iv30") or 0) / 100
    hv20, hv60 = realised_vol(bars, 20), realised_vol(bars, 60)
    hv = max(x for x in (hv20, hv60, 0.0) if x is not None) or None
    iv_ratio = atm_iv / hv if hv else None
    em = spot * atm_iv * math.sqrt(dte / 365) if atm_iv else None
    lo, hi = CFG["long_delta_band"]
    longs = [c for c in calls if lo <= c["delta"] <= hi and liquid(c)]
    if not longs:
        return {"ticker": row["ticker"], "skip": "no liquid ~0.60-delta call in the 30–60 day window", "expiry": expiry}
    long = min(longs, key=lambda c: abs(c["delta"] - CFG["long_delta"]))
    shorts = [c for c in calls if c["strike"] > long["strike"] and c["strike"] >= tp1 and c["bid"] > 0 and c["oi"] >= CFG["min_oi"] / 2 and spread_pct(c) <= CFG["max_spread_pct"] * 1.5]
    short = min(shorts, key=lambda c: abs(c["strike"] - tp2)) if shorts else None
    t_half = max(dte / 2, 5) / 365

    def evaluate(kind: str) -> dict | None:
        if kind == "call":
            legs = [(long, 1)]
            debit = long["ask"]
            debit_mid = mid(long)
            max_value = None
            breakeven = long["strike"] + debit
        else:
            if not short:
                return None
            legs = [(long, 1), (short, -1)]
            debit = long["ask"] - short["bid"]
            debit_mid = mid(long) - mid(short)
            max_value = short["strike"] - long["strike"]
            breakeven = long["strike"] + debit
            if debit <= 0 or debit >= max_value:
                return None
        v1 = project(legs, tp1, t_half, rate)
        v2 = project(legs, tp2, t_half, rate)
        vs = project(legs, stop, t_half, rate)
        if max_value:
            v1, v2, vs = (min(v, max_value) for v in (v1, v2, vs))
        p1, p2, ls = (v1 - debit) * 100, (v2 - debit) * 100, (vs - debit) * 100
        return {
            "kind": kind,
            "legs": [{"side": "buy" if q > 0 else "sell", "symbol": c["symbol"], "strike": c["strike"], "expiry": c["expiry"], "bid": c["bid"], "ask": c["ask"],
                      "mid": round(mid(c), 4), "iv": c["iv"], "delta": c["delta"], "theta": c["theta"], "oi": c["oi"], "volume": c["volume"], "spread_pct": round(spread_pct(c), 4)} for c, q in legs],
            "debit": round(debit, 4), "debit_mid": round(debit_mid, 4), "cost": round(debit * 100, 2), "max_loss": round(debit * 100, 2),
            "max_gain": round((max_value - debit) * 100, 2) if max_value else None, "breakeven": round(breakeven, 4),
            "profit_tp1": round(p1, 2), "profit_tp2": round(p2, 2), "loss_at_stop": round(ls, 2),
            "rr_tp1": round(p1 / -ls, 2) if ls < 0 else None, "rr_tp2": round(p2 / -ls, 2) if ls < 0 else None,
            "theta_day": round(sum(q * c["theta"] for c, q in legs) * 100, 2),
        }

    call = evaluate("call")
    spread = evaluate("spread")
    prefer_spread = (iv_ratio is not None and iv_ratio > CFG["cheap_iv_ratio"]) or (earnings and earnings <= expiry)
    rec = spread if (prefer_spread and spread) else call
    if not rec:
        return None

    # ── tier points (every reason recorded) ──
    pts, why, against = 0.0, [], []

    def add(p, txt):
        nonlocal pts
        pts += p
        (why if p > 0 else against).append(txt)

    sc, cf = row["score"], row["confidence"]
    add(3 if sc >= 75 else 2 if sc >= 65 else 1, f"stock score {sc:.0f}")
    if cf >= 85:
        add(1, f"evidence {cf}")
    tm = timing(bars, spot, zones)
    if tm["uptrend"]:
        add(1, "uptrend (above 50-day, 50-day above 200-day)")
    else:
        add(-1, "not in an uptrend")
    if tm["in_zone"]:
        add(1, "price inside the entry zone")
    elif tm["extended"]:
        add(-1.5, "price stretched above the entry zone")
    if tm["rsi_ok"]:
        add(0.5, f"RSI {tm['rsi']:.0f} (healthy)")
    elif tm["rsi"] is not None and tm["rsi"] > 70:
        add(-1, f"RSI {tm['rsi']:.0f} (overbought)")
    rr = rec.get("rr_tp1")
    if rr is not None and rr >= 1.5:
        add(2, f"option reward/risk {rr:.1f} at TP1")
    elif rr is not None and rr >= 1.0:
        add(1, f"option reward/risk {rr:.1f} at TP1")
    else:
        add(-1, "option payoff at TP1 doesn't beat the loss at the stop")
    if em and tp1 - spot <= em:
        add(1, f"TP1 (+{(tp1 / spot - 1) * 100:.1f}%) inside the options-implied move (±{em / spot * 100:.1f}%)")
    elif em:
        add(-1, f"TP1 needs more than the options-implied move (±{em / spot * 100:.1f}%)")
    if iv_ratio is not None:
        if iv_ratio <= 1.0:
            add(1, f"options cheap: IV {atm_iv * 100:.0f}% vs realised {hv * 100:.0f}%")
        elif iv_ratio > CFG["expensive_iv_ratio"] and rec["kind"] == "call":
            add(-1, f"options expensive: IV {atm_iv * 100:.0f}% vs realised {hv * 100:.0f}%")
    legs_ok = all(l["spread_pct"] <= 0.05 and l["oi"] >= 1000 for l in rec["legs"] if l["side"] == "buy")
    if legs_ok:
        add(1, "very liquid contract (tight spread, 1,000+ open interest)")
    if row.get("insider_buyers_90d") or row.get("inst_adds"):
        add(1, "insider buying / fund additions")
    if earnings and earnings <= expiry:
        add(-2 if rec["kind"] == "call" else -1, f"earnings {earnings} before expiry (IV crush risk)")
    tier = next((t for t, th in CFG["tiers"].items() if pts >= th), None)
    return {
        "ticker": row["ticker"], "id": row["id"], "name": row["name"], "sector": row.get("sector"), "as_of": chain.get("as_of"),
        "spot": spot, "score": sc, "confidence": cf, "tier": tier, "points": round(pts, 1), "why": why, "against": against,
        "expiry": expiry, "dte": dte, "exit_by": (date.fromisoformat(expiry) - timedelta(days=CFG["exit_dte"])).isoformat(),
        "earnings": earnings, "earnings_in_window": bool(earnings and earnings <= expiry),
        "atm_iv": atm_iv, "hv20": hv20, "hv60": hv60, "iv_ratio": iv_ratio, "iv30": chain.get("iv30"), "expected_move": em,
        "underlying": {"entry": sw["entry"], "stop": stop, "tp1": tp1, "tp2": tp2, "zones_at": zones.get("at")},
        "timing": tm, "recommended": rec["kind"], "structures": {k: v for k, v in (("call", call), ("spread", spread)) if v},
        "assumptions": ["prices are Cboe delayed quotes (~15 min); entry priced at the ask (spread: ask − bid)",
                        "payoffs use Black-Scholes with each contract's IV, assuming the level is hit halfway to expiry",
                        f"exit by {CFG['exit_dte']} days to expiry; stop = underlying closes below the swing stop"],
    }


def gate(row: dict, detail: dict) -> bool:
    if row.get("country") != "US" or row.get("quarantined") or row.get("experimental"):
        return False
    if row["score"] < CFG["min_score"] or row["confidence"] < CFG["min_confidence"] or (row.get("mcap") or 0) < CFG["min_mcap"]:
        return False
    sw = ((detail.get("zones") or {}).get("swing") or {})
    tp = (sw.get("tps") or [{}])[0]
    return bool(sw and (tp.get("rr") or 0) >= CFG["min_tp1_rr"])


def prelim(row: dict, detail: dict, bars: list[dict]) -> float:
    tm = timing(bars, row["price"], detail.get("zones") or {})
    return row["score"] + 0.2 * row["confidence"] + 8 * tm["uptrend"] + 6 * tm["in_zone"] - 10 * tm["extended"] + 4 * tm["rsi_ok"] + 5 * bool(row.get("insider_buyers_90d"))


# ── paper tracking ───────────────────────────────────────
def mark(position: dict, chains: dict[str, dict], today: date | None = None) -> dict:
    """Mark an open paper position at exit prices (sell at bid, buy back at ask) and apply the exit rules."""
    today = today or date.today()
    ch = chains.get(position["ticker"])
    if not ch:
        return position
    by = {c["symbol"]: c for c in ch["calls"]}
    value = 0.0
    for l in position["legs"]:
        c = by.get(l["symbol"])
        if not c:
            return position
        value += c["bid"] if l["side"] == "buy" else -c["ask"]
    spot = ch.get("spot")
    pnl = (value - position["debit"]) * 100
    position.update({"value": round(value, 4), "pnl": round(pnl, 2), "pnl_pct": round(value / position["debit"] - 1, 4) if position["debit"] else None,
                     "spot": spot, "marked": today.isoformat()})
    position["peak_pct"] = max(position.get("peak_pct", 0) or 0, position["pnl_pct"] or 0)
    reason = None
    tp_pct = CFG["take_profit_pct"]["spread" if position["kind"] == "spread" else "call"]
    max_value = position.get("max_value")
    if spot and spot >= position["underlying"]["tp2"]:
        reason = "underlying reached TP2"
    elif position["kind"] == "spread" and max_value and value >= tp_pct * max_value:
        reason = f"spread worth {tp_pct:.0%} of its max"
    elif position["kind"] == "call" and (position["pnl_pct"] or 0) >= tp_pct:
        reason = f"call up {tp_pct:.0%}"
    elif spot and spot < position["underlying"]["stop"]:
        reason = "underlying below the stop"
    elif (date.fromisoformat(position["expiry"]) - today).days <= CFG["exit_dte"]:
        reason = f"{CFG['exit_dte']} days to expiry — time exit"
    if reason:
        position.update({"status": "closed", "closed": today.isoformat(), "exit_reason": reason, "exit_value": round(value, 4)})
    return position


def open_paper(setup: dict) -> dict:
    s = setup["structures"][setup["recommended"]]
    return {
        "id": f"{setup['ticker']}-{setup['expiry']}-{store.now_iso()[:10]}", "ticker": setup["ticker"], "sec_id": setup["id"], "tier": setup["tier"],
        "kind": s["kind"], "legs": [{k: l[k] for k in ("side", "symbol", "strike", "expiry")} for l in s["legs"]], "expiry": setup["expiry"],
        "debit": s["debit"], "max_value": (s["max_gain"] / 100 + s["debit"]) if s.get("max_gain") is not None else None,
        "opened": store.now_iso(), "spot_open": setup["spot"], "underlying": setup["underlying"], "status": "open",
        "value": s["debit"], "pnl": 0.0, "pnl_pct": 0.0,
    }


def summary(positions: list[dict]) -> dict:
    closed = [p for p in positions if p["status"] == "closed"]
    wins = [p for p in closed if (p.get("pnl") or 0) > 0]
    by_tier = {}
    for t in ("A", "B"):
        cs = [p for p in closed if p.get("tier") == t]
        by_tier[t] = {"n": len(cs), "win_rate": (sum(1 for p in cs if p["pnl"] > 0) / len(cs)) if cs else None,
                      "avg_pct": (sum(p["pnl_pct"] or 0 for p in cs) / len(cs)) if cs else None}
    return {"open": sum(1 for p in positions if p["status"] == "open"), "closed": len(closed),
            "win_rate": len(wins) / len(closed) if closed else None,
            "avg_pct": sum(p.get("pnl_pct") or 0 for p in closed) / len(closed) if closed else None,
            "total_pnl": round(sum(p.get("pnl") or 0 for p in positions), 2), "by_tier": by_tier}
