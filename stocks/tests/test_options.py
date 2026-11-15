"""Options layer tests — SYNTHETIC chains and prices only."""
import math
from datetime import date, timedelta

import pytest

from conftest import bars_linear
from hoodstocks import options as OP

TODAY = date(2026, 11, 16)


def chain(spot=100.0, iv=0.30, exps=(20, 45, 80), oi=2000, spread=0.04):
    calls = []
    for dte in exps:
        e = (TODAY + timedelta(days=dte)).isoformat()
        t = dte / 365
        for k in range(80, 131, 5):
            v = OP.bs_call(spot, k, t, iv)
            d1 = (math.log(spot / k) + (0.04 + iv * iv / 2) * t) / (iv * math.sqrt(t))
            delta = OP._ncdf(d1)
            half = max(v * spread / 2, 0.01)
            calls.append({"symbol": f"SYN{e[2:4]}{e[5:7]}{e[8:10]}C{k * 1000:08d}", "expiry": e, "strike": float(k), "bid": round(v - half, 2), "ask": round(v + half, 2),
                          "iv": iv, "delta": delta, "theta": -0.03, "vega": 0.1, "oi": oi, "volume": 50, "last": v})
    return {"spot": spot, "iv30": iv * 100, "as_of": "2026-11-16T15:00:00", "calls": calls}


def detail(price=100.0):
    return {"zones": {"at": 0, "price": price, "swing": {"entry": [97.0, 100.0], "stop": 94.0, "atr": 2.0, "hold": [97, 106],
                                                          "tps": [{"label": "TP1", "price": 106.0, "rr": 2.1}, {"label": "TP2", "price": 112.0, "rr": 3.6}]}}}


ROW = {"id": "SEC1", "ticker": "SYN", "name": "Synthetic", "country": "US", "score": 78, "confidence": 92, "mcap": 5e10, "price": 100.0,
       "quarantined": False, "experimental": False, "insider_buyers_90d": 1, "inst_adds": 0, "sector": "Technology"}


def uptrend_bars():
    # SYNTHETIC: steady rise, then a dip into the entry zone with modest volatility
    b = bars_linear(n=300, p0=60, step=0.14)
    for i, x in enumerate(b):  # ±1.6% daily zigzag ≈ 25% realised volatility
        x["c"] = x["adj"] = x["c"] * (1.016 if i % 2 else 0.984)
    for i, x in enumerate(b[-8:]):
        x["c"] = x["adj"] = 101 - i * 0.12
        x["h"], x["l"] = x["c"] * 1.01, x["c"] * 0.99
    return b


def test_occ_symbol_parse():
    j = {"data": {"current_price": 50, "iv30": 25, "options": [{"option": "AAPL261218C00250000", "bid": 1, "ask": 1.1, "iv": 0.3, "delta": 0.5, "open_interest": 10},
                                                              {"option": "AAPL261218P00250000", "bid": 1, "ask": 1.1}]}}
    c = OP.parse_chain(j)["calls"]
    assert len(c) == 1 and c[0]["strike"] == 250.0 and c[0]["expiry"] == "2026-12-18"


def test_black_scholes_sanity():
    v = OP.bs_call(100, 100, 0.25, 0.3, 0.0)
    assert v == pytest.approx(0.4 * 100 * 0.3 * 0.5, rel=0.03)  # ATM ≈ 0.4·S·σ·√t
    assert OP.bs_call(100, 50, 0, 0.3) == 50 and OP.bs_call(100, 150, 0, 0.3) == 0


def test_setup_picks_45_day_expiry_and_060_delta_call_when_cheap():
    st = OP.build_setup(ROW, detail(), chain(iv=0.22), uptrend_bars(), None, 0.04, TODAY)
    assert st["dte"] == 45
    s = st["structures"]["call"]
    assert 0.45 <= s["legs"][0]["delta"] <= 0.75
    assert s["max_loss"] == s["cost"] > 0 and s["breakeven"] > s["legs"][0]["strike"]
    assert s["profit_tp2"] > s["profit_tp1"] > s["loss_at_stop"]
    assert st["recommended"] == "call" and st["tier"] in ("A", "B", "C")
    assert st["exit_by"] == (date.fromisoformat(st["expiry"]) - timedelta(days=21)).isoformat()


def test_spread_when_options_expensive_or_earnings_in_window():
    exp_bars = uptrend_bars()
    st = OP.build_setup(ROW, detail(), chain(iv=0.80), exp_bars, None, 0.04, TODAY)
    assert st["recommended"] == "spread"
    sp = st["structures"]["spread"]
    assert sp["legs"][1]["side"] == "sell" and sp["legs"][1]["strike"] >= 106 and sp["max_gain"] > 0
    assert sp["profit_tp2"] <= sp["max_gain"] + 1e-6
    st2 = OP.build_setup(ROW, detail(), chain(iv=0.22), exp_bars, (TODAY + timedelta(days=20)).isoformat(), 0.04, TODAY)
    assert st2["earnings_in_window"] and st2["recommended"] == "spread"
    assert any("earnings" in a for a in st2["against"])


def test_illiquid_chain_is_skipped():
    st = OP.build_setup(ROW, detail(), chain(oi=10), uptrend_bars(), None, 0.04, TODAY)
    assert st.get("skip")
    st = OP.build_setup(ROW, detail(), chain(spread=0.6), uptrend_bars(), None, 0.04, TODAY)
    assert st.get("skip")


def test_no_window_expiry_returns_none():
    assert OP.build_setup(ROW, detail(), chain(exps=(7, 120)), uptrend_bars(), None, 0.04, TODAY) is None


def test_gate_requires_quality_and_zone_rr():
    assert OP.gate(ROW, detail())
    assert not OP.gate(dict(ROW, score=40), detail())
    assert not OP.gate(dict(ROW, country="CA"), detail())
    assert not OP.gate(dict(ROW, quarantined=True), detail())
    d = detail()
    d["zones"]["swing"]["tps"][0]["rr"] = 0.5
    assert not OP.gate(ROW, d)


def test_paper_exits():
    st = OP.build_setup(ROW, detail(), chain(iv=0.22), uptrend_bars(), None, 0.04, TODAY)
    p = OP.open_paper(st)
    p2 = OP.mark(dict(p), {"SYN": chain(spot=113.0, iv=0.22)}, TODAY + timedelta(days=5))
    assert p2["status"] == "closed" and "TP2" in p2["exit_reason"] and p2["pnl"] > 0
    p3 = OP.mark(dict(p), {"SYN": chain(spot=92.0, iv=0.22)}, TODAY + timedelta(days=5))
    assert p3["status"] == "closed" and "stop" in p3["exit_reason"] and p3["pnl"] < 0
    late = TODAY + timedelta(days=st["dte"] - 20)
    p4 = OP.mark(dict(p), {"SYN": chain(spot=101.0, iv=0.22)}, late)
    assert p4["status"] == "closed" and "time exit" in p4["exit_reason"]
    s = OP.summary([p2, p3])
    assert s["closed"] == 2 and s["win_rate"] == 0.5
