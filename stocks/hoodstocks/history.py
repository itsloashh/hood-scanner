"""Historical accountability: every candidate is recorded once at discovery, then its returns are tracked
(dividend-adjusted, vs benchmark, max drawdown, minus an assumed round-trip cost)."""
from __future__ import annotations

from datetime import date

from . import config, store
from .prices import forward_return, path_drawdown

COST = 0.002  # assumed round-trip trading cost (0.1% each way), subtracted from returns
DISCOVERY_MIN = 60


def record_discoveries(details: dict, macro: dict) -> list[dict]:
    known = {r["security_id"] for r in store.read_lines("candidates.jsonl")}
    new = []
    for sid, d in details.items():
        r = d["row"]
        if sid in known or r["score"] < DISCOVERY_MIN or r["quarantined"]:
            continue
        rec = {
            "security_id": sid, "ticker": r["ticker"], "name": r["name"], "discovered": store.now_iso(), "price_date": r["price_date"],
            "price": r["price"], "currency": r["currency"], "score": r["score"], "class": r["class"], "confidence": r["confidence"],
            "profile": r["profile"], "cap": r["cap"], "experimental": r["experimental"], "risk": r["risk"], "sector": r["sector"],
            "evidence": d["why"], "periods": {k: (d.get("statements") or {}).get(k, {}).get("end") for k in ("revenue", "net_income")} if d.get("statements") else {},
            "valuation": {k: d["scenarios"].get(k) for k in ("method", "base", "bear", "bull", "assumptions")} if d["scenarios"].get("available") else None,
            "score_version": config.SCORE_VERSION, "thesis_status": "open", "benchmark": config.BENCHMARK.get(r["country"], "SPY"),
        }
        new.append(rec)
    store.append("candidates.jsonl", new)
    return new


def snapshot_scores(rows: list[dict]) -> None:
    """Daily point-in-time score snapshot of everything scoring ≥ 50 (append-only, monthly files)."""
    today = date.today().isoformat()
    keep = [{"d": today, "id": r["id"], "s": r["score"], "c": r["confidence"], "p": r["profile"], "px": r["price"]} for r in rows if r["score"] >= 50]
    store.append(f"history/scores-{today[:7]}.jsonl", keep)


def track(bars_by_symbol: dict, master: dict) -> dict:
    cands = store.read_lines("candidates.jsonl")
    out, groups = [], {}
    for c in cands:
        s = master.get(c["security_id"])
        if not s:
            continue
        b = bars_by_symbol.get(s["listings"][0]["yahoo"])
        if not b:
            continue
        bars = b["bars"]
        bench = bars_by_symbol.get(c["benchmark"])
        start = c["price_date"]
        rec = {"security_id": c["security_id"], "ticker": c["ticker"], "discovered": c["discovered"], "score": c["score"], "class": c["class"],
               "profile": c["profile"], "cap": c["cap"], "experimental": c["experimental"], "start_price": c["price"]}
        for label, days in (("30d", 30), ("90d", 90), ("180d", 180), ("365d", 365)):
            r = forward_return(bars, start, days)
            rb = forward_return(bench["bars"], start, days) if bench else None
            rec[f"ret_{label}"] = r - COST if r is not None else None
            rec[f"bench_{label}"] = rb
        last = bars[-1]["adj"]
        first = next((x["adj"] for x in bars if x["t"] >= start[:10]), None)
        rec["ret_total"] = (last / first - 1 - COST) if first else None
        bfirst = next((x["adj"] for x in bench["bars"] if x["t"] >= start[:10]), None) if bench else None
        rec["bench_total"] = (bench["bars"][-1]["adj"] / bfirst - 1) if bfirst else None
        rec["max_drawdown"] = path_drawdown(bars, start)
        rec["status"] = "active" if s.get("status") == "active" else "delisted/inactive (kept in results)"
        out.append(rec)
        for gk in (f"class:{c['class']}", f"profile:{c['profile']}", f"cap:{c['cap']}"):
            groups.setdefault(gk, []).append(rec)
    summary = {}
    for k, recs in groups.items():
        tot = [r["ret_total"] for r in recs if r["ret_total"] is not None]
        exc = [r["ret_total"] - r["bench_total"] for r in recs if r["ret_total"] is not None and r["bench_total"] is not None]
        summary[k] = {"n": len(recs), "avg_return": sum(tot) / len(tot) if tot else None, "avg_excess": sum(exc) / len(exc) if exc else None,
                      "hit_rate": sum(1 for x in exc if x > 0) / len(exc) if exc else None}
    res = {"updated": store.now_iso(), "candidates": out, "groups": summary,
           "notes": ["Returns are dividend-adjusted (adjusted close) minus a 0.2% round-trip cost.",
                     "Candidates are recorded at discovery and never removed, including if they are later delisted.",
                     "Too few closed windows yet to say whether the method works — no profitability claim is made."]}
    store.write("performance.json", res)
    return res
