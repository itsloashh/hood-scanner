"""Entry point: python -m hoodstocks.run <mode>

daily         full research run (macro, universe, prices, filings, scores, alerts, digest, tracking)
insiders      Form 4 sweep for open-market insider purchases (runs several times a day)
institutions  13F quarter-over-quarter comparison for tracked managers
macro         economic data only
backtest      point-in-time backtest from cached data (run after a daily)
"""
from __future__ import annotations

import sys
import time
from datetime import date, timedelta

from . import alerts as AL, config, history, store
from .pipeline import Ctx, log, run_etfs, run_fundamentals, run_institutions, run_insiders, run_macro, run_prices, run_scores, run_universe
from .providers import registry
from .providers.telegram import send


def _round(x, sig=6):
    if isinstance(x, float):
        return float(f"{x:.{sig}g}") if abs(x) < 1e6 else round(x)
    if isinstance(x, dict):
        return {k: _round(v, sig) for k, v in x.items()}
    if isinstance(x, list):
        return [_round(v, sig) for v in x]
    return x


def write_outputs(ctx: Ctx, res: dict, etfs: list[dict], macro: dict) -> None:
    rows = _round(res["rows"])
    std = sorted([r for r in rows if not r["experimental"] and not r["quarantined"]], key=lambda r: -r["score"])
    micro = sorted([r for r in rows if r["experimental"] and not r["quarantined"]], key=lambda r: -r["score"])
    slim = [{k: v for k, v in _round(r, 4).items() if k not in ("model", "dual_listed", "industry", "price_date", "exchange", "currency", "class", "flags", "verified", "ret_1y", "ev_ebitda", "ret_3m")} for r in rows]  # dashboard list (keeps it under 2 MB)
    for r, full in zip(slim, rows):
        r["price"] = full["price"]
    store.write("universe.json", {"updated": store.now_iso(), "count": len(rows), "rows": slim}, compact=True)
    opp = {"updated": store.now_iso(), "score_version": config.SCORE_VERSION,
           "by_profile": {p: [r["id"] for r in std if r["profile"] == p][:50] for p in ("value", "growth", "dividend")},
           "top": [r["id"] for r in std[:100]], "experimental_micro": [r["id"] for r in micro[:40]],
           "quarantined": [r["id"] for r in rows if r["quarantined"]][:200],
           "etfs": _round(sorted(etfs, key=lambda e: -(e.get("score") or 0))), "rotation": res["rotation"], "sector_medians": res["sector_medians"]}
    store.write("opportunities.json", opp, compact=True)
    store.write("rules.json", {"updated": store.now_iso(), "alert": config.ALERT, "eligibility": config.ELIGIBILITY, "micro": config.MICRO_EXPERIMENTAL,
                               "caps": config.CAPS, "classes": config.CLASSES, "profiles": config.PROFILES, "score_version": config.SCORE_VERSION,
                               "dividend": config.DIVIDEND, "value": config.VALUE, "managers": len(config.MANAGERS)})
    # per-security detail pages for anything worth opening (top names, insider buys, institutional activity, watchlist)
    watch = {w.get("security_id") or w.get("ticker") for w in (store.read("watchlist.json", []) or [])}
    want = set(opp["top"]) | set(opp["experimental_micro"]) | {r["id"] for r in rows if r["insider_buyers_90d"] or r["inst_adds"] or r["id"] in watch or r["ticker"] in watch}
    want |= {r["id"] for r in std[:400]}
    old = set(p.stem for p in (config.DATA / "sec").glob("*.json")) if (config.DATA / "sec").exists() else set()
    for sid in want:
        store.write(f"sec/{sid}.json", _round(res["details"][sid]), compact=True)
    for stale in old - want:
        (config.DATA / "sec" / f"{stale}.json").unlink(missing_ok=True)


def daily():
    ctx = Ctx(budget_min=105)
    macro = ctx.stage("macro", run_macro, ctx) or store.read("macro.json", {}) or {}
    u = ctx.stage("universe", run_universe, ctx)
    if not u:
        return finish(ctx, "universe failed — nothing scored this run")
    master, subs = u["master"], u["subs"]
    bars = ctx.stage("prices", run_prices, ctx, master, macro.get("usdcad")) or {}
    facts = ctx.stage("fundamentals", run_fundamentals, ctx, master, subs) or {}
    insiders = ctx.stage("insiders", run_insiders, ctx, master, 5) or store.read("insiders.json", {"by_cik": {}}) or {"by_cik": {}}
    inst = store.read("institutions.json", {}) or {}
    if date.today().weekday() == 0 or not inst:  # weekly (13F changes quarterly)
        inst = ctx.stage("institutions", run_institutions, ctx, master) or inst
    res = ctx.stage("scores", run_scores, ctx, master, subs, bars, facts, insiders, inst, macro)
    if not res:
        return finish(ctx, "scoring failed")
    etfs = ctx.stage("etfs", run_etfs, bars) or []
    prev_rows = {r["id"]: r for r in ((store.read("universe.json", {}) or {}).get("rows") or [])}
    ctx.stage("outputs", write_outputs, ctx, res, etfs, macro)
    new = ctx.stage("history", history.record_discoveries, res["details"], macro) or []
    history.snapshot_scores(res["rows"])
    ctx.stage("tracking", history.track, bars, master)
    ctx.stage("alerts", send_alerts, ctx, res, insiders, inst, prev_rows, new, macro)
    ctx.stage("options", run_options, ctx, res["details"], bars, macro, bool(prev_rows))
    finish(ctx, None, extra={"scored": len(res["rows"])})


def send_alerts(ctx: Ctx, res: dict, insiders: dict, inst: dict, prev_rows: dict, new: list, macro: dict):
    al = AL.Alerts(ctx.http)
    details = res["details"]
    by_score = sorted(details.values(), key=lambda d: -d["row"]["score"])
    first_run = not prev_rows
    for d in by_score[:40]:
        if first_run:
            break  # first run seeds history quietly instead of flooding Telegram
        prev = prev_rows.get(d["row"]["id"])
        al.opportunity(d, prev if prev and prev["score"] >= config.ALERT["opportunity_min_score"] else None)
    today = date.today()
    recent = (today - timedelta(days=3)).isoformat()
    cat, risks = [], []
    for sid, d in details.items():
        r = d["row"]
        for ev in d["events"]:
            if ev["filed"] < recent:
                continue
            if ev["item"] in ("1.03", "3.01", "4.02", "NT") and r["score"] >= 50:
                risks.append({"ticker": r["ticker"], **ev})
                if not first_run:
                    al.catalyst(sid, r, ev, risk=True)
            elif ev["item"] in ("1.01", "2.01", "5.01") and r["score"] >= 65 and not r["quarantined"]:
                cat.append({"ticker": r["ticker"], **ev})
                if not first_run:
                    al.catalyst(sid, r, ev)
        if d["insider"].get("buys") and not first_run:
            latest = max(b["filed"] or "" for b in d["insider"]["buys"])
            al.insider(sid, r, d["insider"], latest)
        if d["institutional"] and not first_run:
            al.institutional(sid, r, d["institutional"])
    if first_run:  # remember what exists so the next run only alerts on what's new
        now = store.now_iso()
        for d in by_score:
            r, sid = d["row"], d["row"]["id"]
            if r["score"] >= config.ALERT["opportunity_min_score"]:
                al.db["sent"][f"opp:{sid}:{r['class']}"] = now
            if d["insider"].get("buys"):
                al.db["sent"][f"ins:{sid}:{max(b['filed'] or '' for b in d['insider']['buys'])}"] = now
            adds = [c for c in d["institutional"] if c["change"] in ("new", "increase")]
            if adds:
                al.db["sent"][f"inst:{sid}:{max(c['period'] for c in adds)}"] = now
            for ev in d["events"]:
                al.db["sent"][f"catalyst:{sid}:{ev['item']}:{ev['filed']}"] = now
                al.db["sent"][f"risk:{sid}:{ev['item']}:{ev['filed']}"] = now
    al.save()
    digest(ctx, al, res, prev_rows, new, cat, risks, insiders, inst, macro)


def digest(ctx, al, res, prev_rows, new, cat, risks, insiders, inst, macro):
    rows = {r["id"]: r for r in res["rows"]}
    dg = {"date": date.today().isoformat(),
          "new": [rows[n["security_id"]] for n in new if n["security_id"] in rows and not rows[n["security_id"]]["experimental"]],
          "improved": [{"ticker": r["ticker"], "from": prev_rows[i]["score"], "to": r["score"]} for i, r in rows.items()
                       if i in prev_rows and r["score"] - prev_rows[i]["score"] >= 8 and r["score"] >= 60],
          "insiders": sorted([{"ticker": rows[sid]["ticker"], "buyers": d["insider"]["buyers_30d"], "value": d["insider"]["buys_value_90d"]}
                              for sid, d in res["details"].items() if d["insider"].get("buyers_30d")], key=lambda x: -x["value"]),
          "institutional": [f"{m['name']}: 13F for {m['period']} filed {m['filed']}" for m in (inst.get("managers") or {}).values()
                            if m.get("filed") and m["filed"] >= (date.today() - timedelta(days=2)).isoformat()],
          "catalysts": cat, "risks": risks,
          "macro": [f"{v['label']}: {v['last']:,.2f} ({v['direction']}, {v['reading']})" for v in (macro.get("readings") or {}).values()
                    if v.get("direction") in ("up", "down") and not v.get("stale") and v.get("last") is not None],
          "watchlist": [], "warnings": [f"{k}: {v.get('error')}" for k, v in ctx.stages.items() if not v.get("ok")]}
    watch = store.read("watchlist.json", []) or []
    for w in watch:
        r = rows.get(w.get("security_id", "")) or next((x for x in rows.values() if x["ticker"] == w.get("ticker")), None)
        p = prev_rows.get(r["id"]) if r else None
        if r and p and abs(r["score"] - p["score"]) >= 5:
            dg["watchlist"].append(f"${r['ticker']} score {p['score']} → {r['score']}")
    store.write(f"digests/{dg['date']}.json", {k: v for k, v in dg.items()})
    if prev_rows:  # the very first run seeds data quietly
        send(ctx.http, AL.digest_text(dg))


def run_options(ctx: Ctx, details: dict, bars: dict, macro: dict, alerts_on: bool = True) -> dict:
    """Option setups for the best bullish stock candidates + paper tracking. See options.py."""
    from . import options as OP
    from .pipeline import cache_get
    rate = ((macro.get("readings") or {}).get("DFF") or {}).get("last")
    rate = rate / 100 if rate else 0.04
    earnings = OP.earnings_calendar(ctx.http)
    rows = {sid: d["row"] for sid, d in details.items()}

    def bars_of(d):
        sym = d.get("yahoo") or d["security"]["listings"][0]["ticker"]
        b = bars.get(sym) or cache_get("bars", sym) or {}
        return b.get("bars") or []

    cands = [(sid, d) for sid, d in details.items() if OP.gate(d["row"], d)]
    cands.sort(key=lambda x: -OP.prelim(x[1]["row"], x[1], bars_of(x[1])))
    cands = cands[: OP.CFG["max_chains"]]
    paper = store.read("options/paper.json", {"positions": []}) or {"positions": []}
    open_tickers = {p["ticker"] for p in paper["positions"] if p["status"] == "open"}
    chains: dict[str, dict] = {}
    for t in [d["row"]["ticker"] for _, d in cands] + sorted(open_tickers):
        if t in chains or ctx.left() < 4 * 60:
            continue
        ch = OP.fetch_chain(ctx.http, t)
        if ch:
            chains[t] = ch
    # IV history (builds IV rank over time)
    hist = store.read("options/iv_history.json", {}) or {}
    today = date.today().isoformat()
    for t, ch in chains.items():
        if ch.get("iv30"):
            h = [x for x in hist.get(t, []) if x[0] != today] + [[today, ch["iv30"]]]
            hist[t] = h[-300:]
    store.write("options/iv_history.json", hist, compact=True)
    setups, skipped = [], []
    for sid, d in cands:
        t = d["row"]["ticker"]
        st = OP.build_setup(d["row"], d, chains.get(t), bars_of(d), earnings.get(t), rate)
        if not st:
            skipped.append({"ticker": t, "why": "no chain / no 30–60 day expiry"})
            continue
        if st.get("skip"):
            skipped.append({"ticker": t, "why": st["skip"]})
            continue
        h = [x[1] for x in hist.get(t, [])]
        if len(h) >= 60 and max(h) > min(h):
            st["iv_rank"] = (h[-1] - min(h)) / (max(h) - min(h))
        if st["tier"]:
            setups.append(st)
        else:
            skipped.append({"ticker": t, "why": f"{st['points']} points (below tier C)", "against": st["against"][:3]})
    setups.sort(key=lambda s: ("ABC".index(s["tier"]), -s["points"]))
    # paper: mark open positions, open new ones for alert-grade setups
    for p in paper["positions"]:
        if p["status"] == "open":
            OP.mark(p, chains)
    al = AL.Alerts(ctx.http) if alerts_on else None
    for st in [s for s in setups if s["tier"] in ("A", "B")]:
        if st["ticker"] in open_tickers:
            continue
        sent = al.option(st) if al and al.count < OP.CFG["max_alerts_per_run"] else False
        if sent:
            paper["positions"].append(OP.open_paper(st))
            open_tickers.add(st["ticker"])
    if al:
        al.save()
    paper["summary"] = OP.summary(paper["positions"])
    paper["updated"] = store.now_iso()
    store.write("options/paper.json", paper)
    out = {"updated": store.now_iso(), "rate": rate, "config": OP.CFG, "setups": setups, "skipped": skipped[:80], "checked": len(cands),
           "chains": len(chains), "notes": ["Bullish call setups only (V1).", "Cboe delayed quotes; Nasdaq earnings calendar.",
                                              "Tier A/B are alerted (max 3 per run, one per stock per 2 weeks) and paper-tracked."]}
    store.write("options/setups.json", out)
    log(f"options: {len(cands)} candidates, {len(chains)} chains, {len(setups)} setups ({sum(s['tier'] == 'A' for s in setups)} A, {sum(s['tier'] == 'B' for s in setups)} B)")
    return out


def options_only(alerts_on: bool = True):
    """Midday refresh: re-price setups from the latest scored candidates and mark the paper positions."""
    import glob
    import json as _json
    ctx = Ctx(budget_min=30)
    details = {}
    for f in glob.glob(str(config.DATA / "sec" / "*.json")):
        try:
            d = _json.loads(open(f).read())
            details[d["row"]["id"]] = d
        except Exception:
            continue
    macro = store.read("macro.json", {}) or {}
    ctx.stage("options", run_options, ctx, details, {}, macro, alerts_on)
    finish(ctx, None, name="health-options.json")


def insiders_only():
    ctx = Ctx(budget_min=25)
    master = store.read("master.json", {}) or {}
    db = ctx.stage("insiders", run_insiders, ctx, master, 3)
    if db and db.get("_new_buys"):
        uni = {r["id"]: r for r in ((store.read("universe.json", {}) or {}).get("rows") or [])}
        al = AL.Alerts(ctx.http)
        from .engines import insider as INS
        for cik in {b[0] for b in db["_new_buys"]}:
            sid = f"SEC{cik}"
            row = uni.get(sid) or {"id": sid, "ticker": (master.get(sid) or {}).get("ticker", cik), "name": (master.get(sid) or {}).get("name")}
            ins = INS.summarize(db["by_cik"].get(cik, []))
            latest = max((b["filed"] or "" for b in ins["buys"]), default="")
            al.insider(sid, row, ins, latest)
        al.save()
    finish(ctx, None, name="health-insiders.json")


def finish(ctx: Ctx, error: str | None, extra: dict | None = None, name: str = "health.json"):
    health = {"updated": store.now_iso(), "error": error, "stages": ctx.stages, "minutes": round((time.time() - ctx.t0) / 60, 1),
              "providers": registry.snapshot(ctx.http.health(), ctx.used), "http": ctx.http.health(), **(extra or {})}
    store.write(name, health)
    log("done", error or "", health["minutes"], "min")


def main(argv=None):
    mode = (argv or sys.argv[1:] or ["daily"])[0]
    if mode == "daily":
        daily()
    elif mode == "insiders":
        insiders_only()
    elif mode == "options":
        options_only()
    elif mode == "optionsdry":  # same, without Telegram alerts or new paper positions (for checking)
        options_only(alerts_on=False)
    elif mode == "institutions":
        ctx = Ctx(budget_min=40)
        ctx.stage("institutions", run_institutions, ctx)
        finish(ctx, None, name="health-institutions.json")
    elif mode == "macro":
        ctx = Ctx(budget_min=10)
        ctx.stage("macro", run_macro, ctx)
        finish(ctx, None, name="health-macro.json")
    elif mode == "backtest":
        from . import backtest
        from .pipeline import cache_get
        ctx = Ctx(budget_min=60)
        master = store.read("master.json", {}) or {}
        facts = {s["cik"]: cache_get("facts", s["cik"]) for s in master.values() if s.get("cik")}
        bars = {s["listings"][0]["yahoo"]: cache_get("bars", s["listings"][0]["yahoo"]) for s in master.values()}
        bars["SPY"] = cache_get("bars", "SPY")
        ctx.stage("backtest", backtest.run, master, {k: v for k, v in facts.items() if v}, {k: v for k, v in bars.items() if v})
        finish(ctx, None, name="health-backtest.json")
    else:
        raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()
