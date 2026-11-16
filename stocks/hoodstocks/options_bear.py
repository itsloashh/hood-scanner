"""Bearish options: PUT setups on verifiably weak stocks — the mirror of options.py (Nov 15 strictness).

A low stock score alone is not a short signal (missing data and fast-growing loss-makers score low too), so a stock
must show its own weakness: low score with verified filings, a confirmed downtrend, lagging its sector, 2+ fundamental
red flags, and no squeeze in progress. Contracts, liquidity, expiry, payoff modelling and tiering mirror the call side.

Nothing here is a recommendation — every setup is a research candidate with its assumptions shown."""
from __future__ import annotations

import math
from datetime import date, timedelta

from . import options as OP
from . import store
from . import zones as ZN

BEAR = {
    "max_score": 30, "min_confidence": 75, "min_mcap": 1e9, "min_price": 10.0, "min_tp1_rr": 1.2,
    "rs_lag": 0.05,  # lagging its sector ETF by 5+ points over 3 months
    "squeeze_5d": 0.15,  # skip if up 15%+ in the last 5 sessions
    "min_flags": 2,
    "grade": {"max_score": 25, "min_confidence": 75, "min_flags": 3},  # "short-grade" = alert + paper trade allowed
    "max_alerts_per_run": 2, "max_chains": 40,
    "spx_above_ma50_penalty": -1,
}


# ── weakness evidence ───────────────────────────────────
def red_flags(detail: dict) -> list[str]:
    m = detail.get("metrics") or {}
    ins = detail.get("insider") or {}
    inst = detail.get("institutional") or []
    review = (detail.get("risk") or {}).get("review") or []
    f = []
    if m.get("fcf") is not None and m["fcf"] < 0:
        f.append("negative free cash flow")
    if m.get("net_income") is not None and m["net_income"] < 0:
        f.append("loss-making over 12 months")
    if m.get("rev_growth") is not None and m["rev_growth"] < -0.02:
        f.append(f"revenue shrinking ({m['rev_growth'] * 100:.0f}% y/y)")
    if m.get("op_margin") is not None and m.get("op_margin_prev") is not None and m["op_margin"] - m["op_margin_prev"] <= -0.02:
        f.append(f"operating margin down {(m['op_margin_prev'] - m['op_margin']) * 100:.1f} pts")
    if (m.get("dilution_1y") or 0) > 0.08:
        f.append(f"shares up {m['dilution_1y'] * 100:.0f}% in a year")
    if (m.get("net_debt_ebitda") or 0) > 4:
        f.append(f"net debt/EBITDA {m['net_debt_ebitda']:.1f}")
    sells, buys = ins.get("sells_value_90d", 0) or 0, ins.get("buys_value_90d", 0) or 0
    if sells > 5e6 and sells > 10 * max(1, buys):
        f.append(f"heavy insider selling (${sells / 1e6:.1f}M in 90 days)")
    cuts = {x.get("manager") for x in inst if x.get("change") in ("decrease", "exit")}
    adds = {x.get("manager") for x in inst if x.get("change") in ("new", "increase")}
    if cuts and len(cuts) > len(adds):
        f.append(f"{len(cuts)} tracked funds cutting vs {len(adds)} adding")
    if any("8-K" in r for r in review):
        f.append("review-level 8-K filed")
    return f


def trend(bars: list[dict]) -> dict:
    c = [b["c"] for b in bars if b.get("c")]
    ma = lambda xs, n: sum(xs[-n:]) / n if len(xs) >= n else None  # noqa: E731
    ma50, ma200 = ma(c, 50), ma(c, 200)
    ma50_prev = ma(c[:-10], 50) if len(c) >= 60 else None
    price = c[-1] if c else None
    out = {"price": price, "ma50": ma50, "ma200": ma200, "ma50_falling": bool(ma50 and ma50_prev and ma50 < ma50_prev)}
    out["downtrend"] = bool(price and ma50 and ma200 and price < ma50 < ma200)
    out["ret_3m"] = (c[-1] / c[-64] - 1) if len(c) > 64 and c[-64] else None
    out["ret_1m"] = (c[-1] / c[-22] - 1) if len(c) > 22 and c[-22] else None
    out["ret_5d"] = (c[-1] / c[-6] - 1) if len(c) > 6 and c[-6] else None
    out["rsi"] = OP.rsi(bars)
    return out


def pool_record(d: dict) -> dict | None:
    """Static part of the gate (from the daily scoring) — kept small so the midday passes can read it."""
    r = d["row"]
    if r.get("country") != "US" or r.get("quarantined") or r.get("experimental"):
        return None
    if r["score"] > BEAR["max_score"] or r["confidence"] < BEAR["min_confidence"] or (r.get("mcap") or 0) < BEAR["min_mcap"] or (r.get("price") or 0) < BEAR["min_price"]:
        return None
    flags = red_flags(d)
    if len(flags) < BEAR["min_flags"]:
        return None
    keep = ("id", "ticker", "name", "sector", "country", "score", "confidence", "mcap", "price", "class", "quarantined", "experimental")
    return {"row": {k: r.get(k) for k in keep}, "flags": flags, "yahoo": d.get("yahoo") or d["security"]["listings"][0]["yahoo"]}


def gate(rec: dict, bars: list[dict], sector_ret3m: float | None) -> tuple[bool, str, dict]:
    tr = trend(bars)
    if not tr["downtrend"]:
        return False, "not in a downtrend (price < 50-day < 200-day)", tr
    if tr["ret_5d"] is not None and tr["ret_5d"] >= BEAR["squeeze_5d"]:
        return False, f"up {tr['ret_5d'] * 100:.0f}% in 5 sessions (squeeze guard)", tr
    if tr["ret_3m"] is None or sector_ret3m is None:
        return False, "no 3-month return to compare with its sector", tr
    lag = tr["ret_3m"] - sector_ret3m
    tr["rs_vs_sector_3m"] = lag
    if lag > -BEAR["rs_lag"]:
        return False, f"not lagging its sector enough ({lag * 100:+.0f} pts over 3 months)", tr
    z = ZN.plan_short(bars[-260:], tr["price"])
    tr["zones"] = z
    if not z or (z["tps"][0]["rr"] or 0) < BEAR["min_tp1_rr"]:
        return False, "short-side reward/risk to TP1 under 1.2", tr
    return True, "", tr


def grade(rec: dict) -> str | None:
    g = BEAR["grade"]
    r = rec["row"]
    return "short-grade" if r["score"] <= g["max_score"] and r["confidence"] >= g["min_confidence"] and len(rec["flags"]) >= g["min_flags"] else None


def prelim(rec: dict, tr: dict) -> float:
    return (BEAR["max_score"] - rec["row"]["score"]) + 0.2 * rec["row"]["confidence"] + 4 * len(rec["flags"]) - 100 * (tr.get("rs_vs_sector_3m") or 0)


# ── contracts ────────────────────────────────────────────
def _abs(puts: list[dict]) -> list[dict]:
    """Puts with |delta| so the call-side expiry/liquidity helpers work unchanged."""
    return [{**p, "delta": abs(p["delta"]), "_delta": p["delta"]} for p in puts]


def project(legs: list[tuple[dict, int]], s: float, t_years: float, r: float) -> float:
    return sum(q * OP.bs_put(s, c["strike"], t_years, max(c["iv"], 0.05), r) for c, q in legs)


def build_setup(rec: dict, tr: dict, chain: dict, bars: list[dict], earnings: str | None, rate: float, spx_above_ma50: bool | None, today: date | None = None) -> dict | None:
    today = today or date.today()
    z = tr.get("zones")
    row = rec["row"]
    if not z or not chain or not chain.get("puts"):
        return None
    spot = chain.get("spot") or row["price"]
    tp1, tp2, stop = z["tps"][0]["price"], z["tps"][1]["price"], z["stop"]
    puts_all = _abs(chain["puts"])
    ex = OP.pick_expiry(puts_all, today)
    if not ex:
        return None
    expiry, dte = ex
    puts = sorted([p for p in puts_all if p["expiry"] == expiry], key=lambda c: c["strike"])
    atm = min(puts, key=lambda c: abs(c["strike"] - spot))
    atm_iv = atm["iv"] or (chain.get("iv30") or 0) / 100
    hv20, hv60 = OP.realised_vol(bars, 20), OP.realised_vol(bars, 60)
    hv = max(x for x in (hv20, hv60, 0.0) if x is not None) or None
    iv_ratio = atm_iv / hv if hv else None
    em = spot * atm_iv * math.sqrt(dte / 365) if atm_iv else None
    lo, hi = OP.CFG["long_delta_band"]
    longs = [c for c in puts if lo <= c["delta"] <= hi and OP.liquid(c)]
    if not longs:
        return {"ticker": row["ticker"], "skip": f"no liquid ~0.60-delta put ({OP.diagnose(puts, expiry).replace('C:', 'P:')})", "expiry": expiry}
    long = min(longs, key=lambda c: abs(c["delta"] - OP.CFG["long_delta"]))
    shorts = [c for c in puts if c["strike"] < long["strike"] and c["strike"] <= tp1 and c["bid"] > 0 and c["oi"] >= OP.CFG["min_oi"] / 2 and OP.spread_pct(c) <= OP.CFG["max_spread_pct"] * 1.5]
    short = min(shorts, key=lambda c: abs(c["strike"] - tp2)) if shorts else None
    t_half = max(dte / 2, 5) / 365

    def evaluate(kind: str) -> dict | None:
        if kind == "put":
            legs, debit, debit_mid, max_value = [(long, 1)], long["ask"], OP.mid(long), None
        else:
            if not short:
                return None
            legs = [(long, 1), (short, -1)]
            debit = long["ask"] - short["bid"]
            debit_mid = OP.mid(long) - OP.mid(short)
            max_value = long["strike"] - short["strike"]
            if debit <= 0 or debit >= max_value:
                return None
        breakeven = long["strike"] - debit
        v1, v2, vs = (project(legs, x, t_half, rate) for x in (tp1, tp2, stop))
        if max_value:
            v1, v2, vs = (min(v, max_value) for v in (v1, v2, vs))
        p1, p2, ls = (v1 - debit) * 100, (v2 - debit) * 100, (vs - debit) * 100
        return {
            "kind": kind,
            "legs": [{"side": "buy" if q > 0 else "sell", "symbol": c["symbol"], "strike": c["strike"], "expiry": c["expiry"], "bid": c["bid"], "ask": c["ask"],
                      "mid": round(OP.mid(c), 4), "iv": c["iv"], "delta": c["_delta"], "theta": c["theta"], "oi": c["oi"], "volume": c["volume"],
                      "spread_pct": round(OP.spread_pct(c), 4)} for c, q in legs],
            "debit": round(debit, 4), "debit_mid": round(debit_mid, 4), "cost": round(debit * 100, 2), "max_loss": round(debit * 100, 2),
            "max_gain": round((max_value - debit) * 100, 2) if max_value else None, "breakeven": round(breakeven, 4),
            "profit_tp1": round(p1, 2), "profit_tp2": round(p2, 2), "loss_at_stop": round(ls, 2),
            "rr_tp1": round(p1 / -ls, 2) if ls < 0 else None, "rr_tp2": round(p2 / -ls, 2) if ls < 0 else None,
            "theta_day": round(sum(q * c["theta"] for c, q in legs) * 100, 2),
        }

    put, spread = evaluate("put"), evaluate("spread")
    if not put and not spread:
        return None
    earn_in = bool(earnings and earnings <= expiry)
    tm = timing(bars, spot, z, tr)
    pp = points(put, rec, tm, em, tp1, spot, iv_ratio, atm_iv, hv, earnings, earn_in, spx_above_ma50) if put else None
    very_liquid = bool(put) and all(l["spread_pct"] <= 0.05 and l["oi"] >= 1000 for l in put["legs"])
    put_ok = bool(put and iv_ratio is not None and iv_ratio <= OP.CFG["call_max_iv_ratio"] and not earn_in and very_liquid and pp[0] >= OP.CFG["tiers"]["A"])
    if put_ok or not spread:
        rec_s, (pts, why, against) = put, pp
        if not put_ok:
            against.append("plain put only because no debit spread could be built (put rules not all met)")
    else:
        rec_s = spread
        pts, why, against = points(spread, rec, tm, em, tp1, spot, iv_ratio, atm_iv, hv, earnings, earn_in, spx_above_ma50)
    if not OP.CFG["dte"][0] <= dte <= OP.CFG["dte"][1]:
        against.append(f"{dte}-day expiry is outside the preferred {OP.CFG['dte'][0]}–{OP.CFG['dte'][1]} days (none available this week)")
    tier = next((t for t, th in OP.CFG["tiers"].items() if pts >= th), None)
    return {
        "direction": "bear", "ticker": row["ticker"], "id": row["id"], "name": row["name"], "sector": row.get("sector"), "as_of": chain.get("as_of"),
        "spot": spot, "score": row["score"], "confidence": row["confidence"], "tier": tier, "points": round(pts, 1), "why": why, "against": against,
        "red_flags": rec["flags"], "expiry": expiry, "dte": dte, "exit_by": (date.fromisoformat(expiry) - timedelta(days=OP.CFG["exit_dte"])).isoformat(),
        "earnings": earnings, "earnings_in_window": earn_in,
        "atm_iv": atm_iv, "hv20": hv20, "hv60": hv60, "iv_ratio": iv_ratio, "iv30": chain.get("iv30"), "expected_move": em,
        "underlying": {"entry": z["entry"], "stop": stop, "tp1": tp1, "tp2": tp2},
        "timing": tm, "recommended": rec_s["kind"], "structures": {k: v for k, v in (("put", put), ("spread", spread)) if v},
        "assumptions": ["prices are Cboe delayed quotes (~15 min); entry priced at the ask (spread: ask − bid)",
                        "payoffs use Black-Scholes with each contract's IV, assuming the level is hit halfway to expiry",
                        f"exit by {OP.CFG['exit_dte']} days to expiry; stop = underlying closes above the short stop"],
    }


def timing(bars: list[dict], price: float, z: dict, tr: dict) -> dict:
    a = z.get("atr")
    entry = z.get("entry") or [None, None]
    r = tr.get("rsi")
    return {
        "ma50": tr.get("ma50"), "ma200": tr.get("ma200"), "rsi": r, "downtrend": tr.get("downtrend"), "ma50_falling": tr.get("ma50_falling"),
        "in_zone": bool(entry[1] and entry[0] * 0.995 <= price <= entry[1]),
        "extended": bool(a and entry[0] and price < entry[0] - 0.75 * a),
        "rsi_ok": bool(r is not None and 30 <= r <= 55), "ret_1m": tr.get("ret_1m"), "rs_vs_sector_3m": tr.get("rs_vs_sector_3m"),
    }


def points(rec_s: dict, rec: dict, tm: dict, em, tp1, spot, iv_ratio, atm_iv, hv, earnings, earn_in, spx_above_ma50) -> tuple[float, list[str], list[str]]:
    pts, why, against = 0.0, [], []

    def add(p, txt):
        nonlocal pts
        pts += p
        (why if p > 0 else against).append(txt)

    sc, cf = rec["row"]["score"], rec["row"]["confidence"]
    add(3 if sc <= 15 else 2 if sc <= 22 else 1, f"stock score {sc:.0f} (weak)")
    if cf >= 85:
        add(1, f"evidence {cf}")
    if tm["downtrend"] and tm["ma50_falling"]:
        add(1, "downtrend with a falling 50-day average")
    if tm["in_zone"]:
        add(1, "bounced into the short entry zone")
    elif tm["extended"]:
        add(-1.5, "already stretched below the short entry zone")
    if tm["rsi_ok"]:
        add(0.5, f"RSI {tm['rsi']:.0f} (room to fall)")
    elif tm["rsi"] is not None and tm["rsi"] < 30:
        add(-1, f"RSI {tm['rsi']:.0f} (oversold)")
    rr = rec_s.get("rr_tp1")
    if rr is not None and rr >= 1.5:
        add(2, f"option reward/risk {rr:.1f} at TP1")
    elif rr is not None and rr >= 1.0:
        add(1, f"option reward/risk {rr:.1f} at TP1")
    else:
        add(-1, "option payoff at TP1 doesn't beat the loss at the stop")
    if em and spot - tp1 <= em:
        add(1, f"TP1 ({(tp1 / spot - 1) * 100:.1f}%) inside the options-implied move (±{em / spot * 100:.1f}%)")
    elif em:
        add(-1, f"TP1 needs more than the options-implied move (±{em / spot * 100:.1f}%)")
    if iv_ratio is not None:
        if iv_ratio <= 1.0:
            add(1, f"options cheap: IV {atm_iv * 100:.0f}% vs realised {hv * 100:.0f}%")
        elif iv_ratio > OP.CFG["expensive_iv_ratio"] and rec_s["kind"] == "put":
            add(-1, f"options expensive: IV {atm_iv * 100:.0f}% vs realised {hv * 100:.0f}%")
    if all(l["spread_pct"] <= 0.05 and l["oi"] >= 1000 for l in rec_s["legs"] if l["side"] == "buy"):
        add(1, "very liquid contract (tight spread, 1,000+ open interest)")
    if any(("insider selling" in f) or ("funds cutting" in f) for f in rec["flags"]):
        add(1, "insider selling / funds cutting")
    if earn_in:
        add(-2 if rec_s["kind"] == "put" else -1, f"earnings {earnings} before expiry (IV crush risk)")
    if spx_above_ma50:
        add(BEAR["spx_above_ma50_penalty"], "S&P 500 above its 50-day — shorting against a rising market")
    return pts, why, against


def write_pool(details: dict) -> list[dict]:
    pool = [p for p in (pool_record(d) for d in details.values()) if p]
    store.write("options/bear_pool.json", {"updated": store.now_iso(), "rules": BEAR, "pool": pool}, compact=True)
    return pool
