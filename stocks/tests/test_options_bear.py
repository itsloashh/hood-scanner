"""Bearish (put) options tests — SYNTHETIC prices and chains only."""
import math
from datetime import date, timedelta

from conftest import bars_linear
from hoodstocks import options as OP
from hoodstocks import options_bear as B
from hoodstocks import zones as ZN

TODAY = date(2026, 11, 16)


def down_bars():
    # SYNTHETIC: steady decline with a ±1.6% zigzag, then a small bounce toward resistance
    b = bars_linear(n=300, p0=160, step=-0.2)
    for i, x in enumerate(b):
        x["c"] = x["adj"] = x["c"] * (1.016 if i % 2 else 0.984)
        x["h"], x["l"] = x["c"] * 1.01, x["c"] * 0.99
    for i, x in enumerate(b[-6:]):
        x["c"] = x["adj"] = 100 + i * 0.15
        x["h"], x["l"] = x["c"] * 1.01, x["c"] * 0.99
    return b


def put_chain(spot=100.0, iv=0.30, exps=(20, 45, 80), oi=2000, spread=0.04):
    puts, calls = [], []
    for dte in exps:
        e = (TODAY + timedelta(days=dte)).isoformat()
        t = dte / 365
        for k in range(70, 121, 5):
            v = OP.bs_put(spot, k, t, iv)
            d1 = (math.log(spot / k) + (0.04 + iv * iv / 2) * t) / (iv * math.sqrt(t))
            half = max(v * spread / 2, 0.01)
            puts.append({"symbol": f"SYN{e[2:4]}{e[5:7]}{e[8:10]}P{k * 1000:08d}", "expiry": e, "strike": float(k), "bid": round(v - half, 2), "ask": round(v + half, 2),
                         "iv": iv, "delta": OP._ncdf(d1) - 1, "theta": -0.03, "vega": 0.1, "oi": oi, "volume": 50, "last": v})
    return {"spot": spot, "iv30": iv * 100, "as_of": "2026-11-16T15:00:00", "calls": calls, "puts": puts}


WEAK = {"metrics": {"fcf": -50, "net_income": -20, "rev_growth": -0.08, "op_margin": 0.02, "op_margin_prev": 0.06, "dilution_1y": 0.1, "net_debt_ebitda": 5},
        "insider": {"sells_value_90d": 8e6, "buys_value_90d": 0}, "institutional": [{"manager": "A", "change": "exit"}, {"manager": "B", "change": "decrease"}],
        "risk": {"review": []}, "yahoo": "SYN", "security": {"listings": [{"yahoo": "SYN"}]},
        "row": {"id": "SEC9", "ticker": "SYN", "name": "Synthetic", "sector": "Technology", "country": "US", "score": 18, "confidence": 90, "mcap": 5e9, "price": 100.0}}


def test_short_zones_mirror_the_long_side():
    b = down_bars()
    z = ZN.plan_short(b, 100.9)
    assert z["entry"][0] == 100.9 and z["entry"][1] > 100.9
    assert z["stop"] > z["entry"][1] and z["stop"] - 100.9 >= z["atr"] * 0.99
    assert z["tps"][0]["price"] < 100.9 and z["tps"][1]["price"] < z["tps"][0]["price"]
    assert all(t["rr"] > 0 for t in z["tps"])


def test_weakness_needs_real_red_flags_not_just_a_low_score():
    flags = B.red_flags(WEAK)
    assert len(flags) >= 7 and any("insider selling" in f for f in flags) and any("funds cutting" in f for f in flags)
    assert B.pool_record(WEAK)["flags"] == flags
    healthy = {**WEAK, "metrics": {"fcf": 50, "net_income": 20, "rev_growth": 0.1}, "insider": {}, "institutional": []}
    assert B.pool_record(healthy) is None  # low score but no evidence of weakness
    assert B.pool_record({**WEAK, "row": {**WEAK["row"], "score": 31}}) is None
    assert B.pool_record({**WEAK, "row": {**WEAK["row"], "confidence": 74}}) is None
    assert B.pool_record({**WEAK, "row": {**WEAK["row"], "price": 8}}) is None  # cheap stocks squeeze
    assert B.grade(B.pool_record(WEAK)) == "short-grade"
    assert B.grade({"row": {"score": 28, "confidence": 90}, "flags": flags}) is None  # short-grade needs 25 or under


def test_gate_requires_downtrend_lagging_sector_and_no_squeeze():
    rec = B.pool_record(WEAK)
    b = down_bars()
    ok, why, tr = B.gate(rec, b, sector_ret3m=0.05)
    assert ok, why
    assert not B.gate(rec, b, sector_ret3m=-0.40)[0]  # the whole sector fell more
    up = bars_linear(n=300, p0=60, step=0.2)
    assert "downtrend" in B.gate(rec, up, 0.0)[1]
    sq = down_bars()
    for i, x in enumerate(sq[-5:]):
        x["c"] = x["adj"] = 100 * (1.05 ** (i + 1))
    assert "squeeze" in B.gate(rec, sq, 0.05)[1] or "downtrend" in B.gate(rec, sq, 0.05)[1]


def test_put_setup_prices_puts_and_prefers_a_debit_spread():
    rec = B.pool_record(WEAK)
    b = down_bars()
    ok, _, tr = B.gate(rec, b, 0.05)
    st = B.build_setup(rec, tr, put_chain(spot=100.9, iv=0.30), b, None, 0.04, spx_above_ma50=False, today=TODAY)
    assert st["direction"] == "bear" and st["dte"] == 45
    s = st["structures"]["put"]
    assert -0.75 <= s["legs"][0]["delta"] <= -0.45
    assert s["breakeven"] < s["legs"][0]["strike"]
    assert s["profit_tp2"] > s["profit_tp1"] > s["loss_at_stop"]
    sp = st["structures"]["spread"]
    assert sp["legs"][1]["side"] == "sell" and sp["legs"][1]["strike"] < sp["legs"][0]["strike"] and sp["legs"][1]["strike"] <= st["underlying"]["tp1"]
    assert sp["profit_tp2"] <= sp["max_gain"] + 1e-6
    # expensive options or earnings in the window → spread
    st2 = B.build_setup(rec, tr, put_chain(spot=100.9, iv=0.80), b, None, 0.04, False, TODAY)
    assert st2["recommended"] == "spread"
    st3 = B.build_setup(rec, tr, put_chain(spot=100.9, iv=0.30), b, (TODAY + timedelta(days=20)).isoformat(), 0.04, False, TODAY)
    assert st3["earnings_in_window"] and st3["recommended"] == "spread"
    # shorting against a rising S&P 500 costs a point
    st4 = B.build_setup(rec, tr, put_chain(spot=100.9, iv=0.30), b, None, 0.04, True, TODAY)
    assert st4["points"] == round(st["points"] - 1, 1) or st4["recommended"] != st["recommended"]
    assert any("S&P 500" in a for a in st4["against"])


def test_bear_paper_exits_flip():
    pos = {"ticker": "SYN", "kind": "put", "direction": "bear", "debit": 3.0, "expiry": (TODAY + timedelta(days=45)).isoformat(),
           "legs": [{"side": "buy", "symbol": "P1"}], "underlying": {"stop": 104.0, "tp1": 95.0, "tp2": 90.0}, "status": "open"}
    ch = {"spot": 89.5, "calls": [], "puts": [{"symbol": "P1", "bid": 5.0, "ask": 5.2}]}
    assert OP.mark(dict(pos), {"SYN": ch}, TODAY)["exit_reason"] == "underlying reached TP2"
    ch2 = {"spot": 104.5, "calls": [], "puts": [{"symbol": "P1", "bid": 1.5, "ask": 1.6}]}
    assert OP.mark(dict(pos), {"SYN": ch2}, TODAY)["exit_reason"] == "underlying above the short stop"
    ch3 = {"spot": 98.0, "calls": [], "puts": [{"symbol": "P1", "bid": 6.1, "ask": 6.3}]}
    assert OP.mark(dict(pos), {"SYN": ch3}, TODAY)["exit_reason"] == "put up 100%"
