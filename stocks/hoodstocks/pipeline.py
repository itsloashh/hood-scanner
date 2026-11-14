"""The daily research pipeline: universe → prices → filings → engines → scores → outputs.
Each stage fails soft: a broken provider marks its data stale and the run carries on without it."""
from __future__ import annotations

import json
import time
import traceback
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import config, fundamentals as F, master as M, metrics as MET, store
from .engines import confidence as CONF, dividend as DIV, etf as ETF, growth as GROW, insider as INS, institutional as INST
from .engines import macro as MAC, risk as RISK, scoring as SC, value as VAL
from .http import FetchError, Http
from .prices import merge_bars, needs_refetch, stats as pxstats
from .providers import macro as macro_src, nasdaq, news as news_src, registry
from .providers.sec import ITEM_8K, Sec, filing_url, parse_13f_table, parse_form4, thirteenf_value_usd
from .providers.yahoo import Yahoo


def log(*a):
    print(datetime.now(timezone.utc).strftime("%H:%M:%S"), *a, flush=True)


def _cache(kind: str, key: str) -> Path:
    p = config.CACHE / kind / f"{key.replace('/', '_')}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def cache_get(kind, key, max_age_h=None):
    p = _cache(kind, key)
    if not p.exists():
        return None
    if max_age_h is not None and time.time() - p.stat().st_mtime > max_age_h * 3600:
        return None
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        return None


def cache_put(kind, key, obj):
    _cache(kind, key).write_text(json.dumps(obj, separators=(",", ":")))


class Ctx:
    def __init__(self, budget_min: float = 100):
        self.http = Http(cache_dir=config.CACHE / "http")
        self.sec = Sec(self.http)
        self.yahoo = Yahoo(self.http)
        self.t0 = time.time()
        self.budget = budget_min * 60
        self.stages: dict[str, dict] = {}
        self.used = {"sec_edgar": ["www.sec.gov", "data.sec.gov"], "yahoo": ["query1.finance.yahoo.com"], "fred": ["fred.stlouisfed.org"],
                     "bank_of_canada": ["www.bankofcanada.ca"], "openfigi": ["api.openfigi.com"], "google_news": ["news.google.com"]}

    def left(self) -> float:
        return self.budget - (time.time() - self.t0)

    def stage(self, name, fn, *a, **kw):
        t = time.time()
        log(f"── {name}")
        try:
            out = fn(*a, **kw)
            self.stages[name] = {"ok": True, "sec": round(time.time() - t)}
            return out
        except Exception as e:  # keep going; mark the stage failed
            traceback.print_exc()
            self.stages[name] = {"ok": False, "sec": round(time.time() - t), "error": f"{type(e).__name__}: {str(e)[:200]}"}
            return None


# ── 1. Macro ─────────────────────────────────────────────
def run_macro(ctx: Ctx) -> dict:
    readings, series_out = {}, {}
    for sid, (label, unit) in macro_src.FRED_SERIES.items():
        try:
            s = macro_src.fred(ctx.http, sid)
        except Exception as e:
            readings[sid] = {"label": label, "status": "unavailable", "error": str(e)[:120]}
            continue
        stale = 120 if sid in ("GDPC1",) else 75 if sid in ("CPIAUCSL", "PCEPILFE", "UNRATE", "IPMAN", "PCOPPUSDM") else 10
        r = MAC.classify(sid, s, stale)
        readings[sid] = {"label": label, "unit": unit, "source": "FRED", "url": f"https://fred.stlouisfed.org/series/{sid}", **r}
        series_out[sid] = s[-260:]
    try:
        b = macro_src.boc(ctx.http, list(macro_src.BOC_SERIES))
        for sid, s in b.items():
            label, unit = macro_src.BOC_SERIES[sid]
            r = MAC.classify(sid, s, 10)
            readings[sid] = {"label": label, "unit": unit, "source": "Bank of Canada", "url": "https://www.bankofcanada.ca/valet/docs", **r}
            series_out[sid] = s[-260:]
    except Exception as e:
        readings["V39079"] = {"label": "Bank of Canada", "status": "unavailable", "error": str(e)[:120]}
    for sym, label in (("GC=F", "Gold (futures)"), ("SI=F", "Silver (futures)")):
        try:
            ch = ctx.yahoo.chart(sym, "1y")
            s = [(b["t"], b["c"]) for b in ch["bars"]]
            r = MAC.classify(sym, s, 6)
            readings[sym] = {"label": label, "unit": "USD", "source": "Yahoo (delayed)", **r}
            series_out[sym] = s[-260:]
        except Exception:
            readings[sym] = {"label": label, "status": "unavailable"}
    tilt = MAC.sector_tilt(readings)
    usdcad = (readings.get("FXUSDCAD") or {}).get("last") or (readings.get("DEXCAUS") or {}).get("last")
    out = {"updated": store.now_iso(), "readings": readings, "sector_tilt": tilt, "usdcad": usdcad,
           "usdcad_source": "Bank of Canada" if (readings.get("FXUSDCAD") or {}).get("last") else "FRED"}
    store.write("macro.json", out)
    store.write("macro_series.json", series_out, compact=True)
    return out


# ── 2. Universe + security master ────────────────────────
def run_universe(ctx: Ctx) -> dict:
    prev = store.read("master.json", {}) or {}
    try:
        scr_rows = nasdaq.screener(ctx.http)
        scr = {r["ticker"]: r for r in scr_rows}
    except Exception as e:
        log("screener unavailable:", e)
        scr = {s["ticker"]: {"price": (s.get("screener") or {}).get("price"), "mcap": (s.get("screener") or {}).get("mcap"),
                              "volume": (s.get("screener") or {}).get("volume")} for s in prev.values() if s.get("asset_type") == "stock"}
    sec_rows = ctx.sec.tickers()
    # candidates worth a submissions lookup: listed on a US exchange, ≥ $1 and ≥ $50M on the screener
    keep_ciks = set()
    for r in sec_rows:
        s = scr.get(r["ticker"].upper()) or scr.get(r["ticker"].upper().replace("-", "/"))
        if r.get("exchange") in config.US_EXCHANGES and s and (s.get("price") or 0) >= 1 and (s.get("mcap") or 0) >= config.MICRO_EXPERIMENTAL["min_mcap_usd"]:
            keep_ciks.add(str(r["cik"]))
    log(f"{len(sec_rows)} SEC tickers, {len(scr)} screener rows → {len(keep_ciks)} issuers to look up")
    recent = set()
    try:
        for row in ctx.sec.recent_filings(3, {"10-K", "10-Q", "20-F", "40-F", "8-K", "6-K", "SC 13D", "SCHEDULE 13D", "SC 13G", "SCHEDULE 13G", "4"}):
            recent.add(row["cik"])
    except Exception as e:
        log("daily index unavailable:", e)
    subs = {}
    for i, cik in enumerate(sorted(keep_ciks)):
        cached = cache_get("sub", cik)
        fresh = cached and cached.get("_fetched", 0) > time.time() - 7 * 86400 and cik not in recent
        if fresh:
            subs[cik] = cached
            continue
        if ctx.left() < 60 * 60:  # keep an hour for the rest of the run
            if cached:
                subs[cik] = cached
            continue
        try:
            s = M.summarize_submissions(ctx.sec.submissions(cik, cache_hours=0))
            s["_fetched"] = time.time()
            cache_put("sub", cik, s)
            subs[cik] = s
        except Exception as e:
            if cached:
                subs[cik] = cached
            if not isinstance(e, FetchError) or e.status != 404:
                log("submissions", cik, e)
        if i % 500 == 0:
            log(f"  submissions {i}/{len(keep_ciks)}")
    master = M.build(M.MasterInputs(sec_rows=sec_rows, screener=scr, subs=subs))
    master = {k: v for k, v in master.items() if v["country"] in ("US", "CA")}
    for sid, s in master.items():  # keep earlier verified TSX listings
        old = prev.get(sid)
        if old and len(old.get("listings", [])) > 1:
            s["listings"] = old["listings"]
    M.add_etfs(master)
    changes = M.ticker_changes(prev, master)
    store.append("ticker_history.jsonl", changes)
    for sid, o in prev.items():  # securities that disappeared → marked inactive, not deleted
        if sid not in master and o.get("asset_type") == "stock" and o.get("status") == "active":
            o = dict(o, status="inactive", inactive_since=store.now_iso())
            master[sid] = o
    store.write("master.json", master, compact=True)
    log(f"master: {sum(1 for s in master.values() if s['asset_type'] == 'stock' and s['status'] == 'active')} stocks "
        f"({sum(1 for s in master.values() if s['country'] == 'CA' and s['asset_type'] == 'stock')} Canadian), {len(changes)} ticker changes")
    return {"master": master, "subs": subs, "screener": scr}


# ── 3. Prices ────────────────────────────────────────────
def get_bars(ctx: Ctx, symbol: str) -> dict | None:
    c = cache_get("bars", symbol)
    if c and c.get("_fetched", 0) > time.time() - 18 * 3600:
        return c
    try:
        if c and c.get("bars"):
            new = ctx.yahoo.chart(symbol, "1mo", cache_hours=0)
            if new and new["bars"] and not needs_refetch(c["bars"], new["bars"]) and \
                    {s["date"] for s in new["splits"]} <= {s["date"] for s in c["splits"]}:
                c["bars"] = merge_bars(c["bars"], new["bars"])[-1300:]
                divs = {d["ex_date"]: d for d in c["dividends"]}
                for d in new["dividends"]:
                    divs[d["ex_date"]] = d
                c["dividends"] = sorted(divs.values(), key=lambda d: d["ex_date"])
                c.update({k: new[k] for k in ("price", "price_time", "currency", "name", "exchange") if new.get(k) is not None})
                c["_fetched"] = time.time()
                cache_put("bars", symbol, c)
                return c
        full = ctx.yahoo.chart(symbol, "5y", cache_hours=0)
        if full:
            full["_fetched"] = time.time()
            cache_put("bars", symbol, full)
        return full
    except Exception as e:
        log("price", symbol, e)
        return c  # stale copy (flagged stale by price_fresh)


def run_prices(ctx: Ctx, master: dict, usdcad: float | None) -> dict:
    bars = {}
    syms = []
    for s in master.values():
        if s["status"] != "active":
            continue
        scr = s.get("screener") or {}
        if s["asset_type"] == "stock" and (scr.get("mcap") or 0) < config.MICRO_EXPERIMENTAL["min_mcap_usd"] and scr.get("mcap") is not None:
            continue
        syms.append(s["listings"][0]["yahoo"])
    syms += [f"{s['ticker']}.TO" for s in master.values() if s["country"] == "CA" and s["asset_type"] == "stock" and s["status"] == "active" and len(s["listings"]) == 1]
    syms += [t for t in config.TSX_EXTRA]
    log(f"prices for {len(syms)} symbols")
    for i, sym in enumerate(dict.fromkeys(syms)):
        if ctx.left() < 35 * 60:
            log("time budget: stopping price refresh, using cached prices for the rest")
            for rest in syms[i:]:
                c = cache_get("bars", rest)
                if c:
                    bars[rest] = c
            break
        b = get_bars(ctx, sym)
        if b and b.get("bars"):
            bars[sym] = b
        if i % 500 == 0:
            log(f"  prices {i}/{len(syms)}")
    # verify Canadian dual listings: TSX ticker exists, trades in CAD, and price ≈ US price × USD/CAD
    tsx_matched = set()
    for s in master.values():
        if s["country"] != "CA" or s["asset_type"] != "stock":
            continue
        us, ca = bars.get(s["listings"][0]["yahoo"]), bars.get(f"{s['ticker']}.TO")
        if us and ca and ca.get("currency") == "CAD" and usdcad and us["bars"] and ca["bars"]:
            ratio = ca["bars"][-1]["c"] / (us["bars"][-1]["c"] * usdcad)
            if 0.93 <= ratio <= 1.07 and len(s["listings"]) == 1:
                s["listings"].append({"ticker": f"{s['ticker']}.TO", "exchange": "TSX", "currency": "CAD", "yahoo": f"{s['ticker']}.TO", "verified": "price matches US listing × USD/CAD"})
        for l in s["listings"]:
            if l["exchange"] == "TSX":
                tsx_matched.add(l["yahoo"])
    M.add_tsx_only(master, tsx_matched)
    for sid, s in master.items():
        if sid.startswith("TSX-"):
            b = bars.get(s["ticker"])
            if b:
                s["name"] = b.get("name") or s["name"]
    store.write("master.json", master, compact=True)
    return bars


# ── 4. Fundamentals ──────────────────────────────────────
def run_fundamentals(ctx: Ctx, master: dict, subs: dict) -> dict:
    out = {}
    ciks = sorted({s["cik"] for s in master.values() if s.get("cik") and s["status"] == "active"})
    for i, cik in enumerate(ciks):
        sub = subs.get(cik) or {}
        last_fin = max((f["filed"] for f in sub.get("filings", []) if f["form"] in ("10-K", "10-Q", "20-F", "40-F", "10-K/A", "10-Q/A", "20-F/A", "40-F/A")), default="")
        c = cache_get("facts", cik)
        if c and c.get("_v") == F.FACTS_VERSION and c.get("_last_fin", "") >= last_fin and c.get("_fetched", 0) > time.time() - 30 * 86400:
            out[cik] = c
            continue
        if ctx.left() < 25 * 60:
            if c:
                out[cik] = c
            continue
        try:
            cf = F.compact_facts(ctx.sec.company_facts(cik, cache_hours=0))
            cf["_last_fin"] = last_fin
            cf["_fetched"] = time.time()
            cache_put("facts", cik, cf)
            out[cik] = cf
        except FetchError as e:
            if c:
                out[cik] = c
            if e.status != 404:
                log("facts", cik, e)
        except Exception as e:
            if c:
                out[cik] = c
            log("facts", cik, e)
        if i % 500 == 0:
            log(f"  facts {i}/{len(ciks)}")
    return out


# ── 5. Insiders (Form 4) ─────────────────────────────────
def run_insiders(ctx: Ctx, master: dict | None = None, days: int = 4) -> dict:
    master = master or store.read("master.json", {}) or {}
    ciks = {s["cik"]: s for s in master.values() if s.get("cik") and s["status"] == "active"}
    db = store.read("insiders.json", {"by_cik": {}, "done": []}) or {"by_cik": {}, "done": []}
    done = set(db.get("done", []))
    rows = ctx.sec.recent_filings(days, {"4", "4/A"})
    todo = []
    for r in rows:
        if r["cik"] in ciks and r["path"] not in done:
            todo.append(r)
    todo = list({r["path"]: r for r in todo}.values())
    log(f"Form 4: {len(rows)} index rows, {len(todo)} new for our universe")
    new_buys = []
    for i, r in enumerate(todo):
        if ctx.left() < 10 * 60:
            break
        try:
            txt = ctx.sec.text(r["path"])
        except Exception as e:
            log("form4", r["path"], e)
            continue
        f = parse_form4(txt)
        done.add(r["path"])
        if not f or not f.get("issuer_cik"):
            continue
        icik = str(int(f["issuer_cik"]))
        if icik not in ciks:
            continue
        acc = r["path"].split("/")[-1].replace(".txt", "")
        f["filed"] = r["date"]
        f["url"] = filing_url(icik, acc)
        f["accession"] = acc
        f["transactions"] = [t for t in f["transactions"] if t["type"] in ("open_market_purchase", "open_market_sale", "option_exercise", "award", "tax_withholding")]
        if not f["transactions"]:
            continue
        db["by_cik"].setdefault(icik, []).append(f)
        for t in f["transactions"]:
            if t["type"] == "open_market_purchase" and not t["plan_10b5_1"]:
                new_buys.append((icik, f, t))
    cut = (date.today() - timedelta(days=150)).isoformat()
    for k in list(db["by_cik"]):
        db["by_cik"][k] = [f for f in db["by_cik"][k] if f.get("filed", "") >= cut]
        if not db["by_cik"][k]:
            del db["by_cik"][k]
    db["done"] = sorted(done)[-30000:]
    db["updated"] = store.now_iso()
    store.write("insiders.json", db, compact=True)
    db["_new_buys"] = new_buys
    return db


# ── 6. Institutions (13F + 13D/G) ────────────────────────
def latest_13f(ctx: Ctx, mcik: str) -> list[dict]:
    sub = ctx.sec.submissions(mcik, cache_hours=12)
    r = sub["filings"]["recent"]
    out = []
    for i, form in enumerate(r["form"]):
        if form == "13F-HR":
            out.append({"acc": r["accessionNumber"][i], "period": r["reportDate"][i], "filed": r["filingDate"][i], "name": sub.get("name")})
    return sorted(out, key=lambda x: x["period"], reverse=True)


def holdings(ctx: Ctx, mcik: str, f: dict) -> list[dict]:
    c = cache_get("13f", f["acc"])
    if c:  # an empty result is never trusted from cache
        return c
    idx = ctx.sec.filing_index(mcik, f["acc"])
    items = idx.get("directory", {}).get("item", [])
    xmls = [it["name"] for it in items if it["name"].lower().endswith(".xml") and "primary_doc" not in it["name"].lower()]
    rows = []
    for x in xmls:
        rows = parse_13f_table(ctx.sec.text(filing_url(mcik, f["acc"], x)))
        if rows:
            break
    for r in rows:
        r["value_usd"] = thirteenf_value_usd(r.get("value_raw"), f["filed"])
    agg = INST.aggregate(rows)
    if agg:
        cache_put("13f", f["acc"], agg)
    return agg


def run_institutions(ctx: Ctx, master: dict | None = None) -> dict:
    master = master or store.read("master.json", {}) or {}
    names = {}
    for s in master.values():
        if s.get("cik") and s["asset_type"] == "stock" and not s.get("share_class_of"):
            names[norm_name(s["name"])] = s["security_id"]
    cmap = store.read("cusip_map.json", {}) or {}
    db = {"managers": {}, "by_security": {}, "updated": store.now_iso(),
          "note": "13F holdings are quarter-end snapshots filed up to 45 days later. They are not live trades."}
    from .providers.openfigi import map_cusips
    for mcik, label in config.MANAGERS.items():
        if ctx.left() < 8 * 60:
            break
        try:
            fs = latest_13f(ctx, mcik)
        except Exception as e:
            db["managers"][mcik] = {"name": label, "error": str(e)[:120]}
            continue
        if len(fs) < 2:
            db["managers"][mcik] = {"name": label, "error": "fewer than two 13F-HR filings"}
            continue
        cur_f, prev_f = fs[0], fs[1]
        first_word = label.split()[0].lower().strip(".")
        if first_word not in (cur_f["name"] or "").lower():
            db["managers"][mcik] = {"name": label, "edgar_name": cur_f["name"], "error": "CIK belongs to a different filer — skipped"}
            continue
        if cur_f["period"] < (date.today() - timedelta(days=200)).isoformat():
            db["managers"][mcik] = {"name": label, "edgar_name": cur_f["name"], "period": cur_f["period"], "error": "no 13F in the last 200 days — skipped"}
            continue
        try:
            cur, prev = holdings(ctx, mcik, cur_f), holdings(ctx, mcik, prev_f)
        except Exception as e:
            db["managers"][mcik] = {"name": label, "error": str(e)[:120]}
            continue
        ch = INST.compare(prev, cur)
        map_cusips(ctx.http, [c["cusip"] for c in ch if c["change"] != "unchanged"][:300], cmap)
        db["managers"][mcik] = {"name": label, "edgar_name": cur_f["name"], "period": cur_f["period"], "filed": cur_f["filed"],
                                "prev_period": prev_f["period"], "positions": len(cur), "url": filing_url(mcik, cur_f["acc"])}
        for c in ch:
            sid = None
            m = cmap.get(c["cusip"])
            if m and m.get("ticker"):
                res = M.resolve(master, m["ticker"])
                sid = res.get("match", {}).get("security_id")
            if not sid:
                sid = names.get(norm_name(c["issuer"] or ""))
            if not sid:
                continue
            c.update({"manager": label, "manager_cik": mcik, "period": cur_f["period"], "filed": cur_f["filed"], "prev_period": prev_f["period"],
                      "source": filing_url(mcik, cur_f["acc"])})
            c["text"] = INST.describe(c, label, cur_f["period"], cur_f["filed"])
            db["by_security"].setdefault(sid, []).append(c)
    store.write("cusip_map.json", cmap, compact=True)
    store.write("institutions.json", db, compact=True)
    return db


def norm_name(n: str) -> str:
    import re
    n = n.upper()
    n = re.sub(r"[^A-Z0-9 ]", " ", n)
    n = re.sub(r"\b(INC|CORP|CORPORATION|CO|LTD|LIMITED|PLC|HOLDINGS|HLDGS|GROUP|THE|CLASS|CL|COM|NEW|SA|NV|LP|LLC|DEL)\b", " ", n)
    return " ".join(n.split())


# ── 7. Score everything ──────────────────────────────────
def events_for(sub: dict | None, days: int = 90) -> tuple[list[dict], list[dict]]:
    if not sub:
        return [], []
    cut = (date.today() - timedelta(days=days)).isoformat()
    ev, holders = [], []
    for f in sub.get("filings", []):
        if f["filed"] < cut:
            continue
        if f["form"] in ("8-K", "8-K/A"):
            for it in [x.strip() for x in (f.get("items") or "").split(",") if x.strip()]:
                if it in ITEM_8K:
                    ev.append({"item": it, "type": ITEM_8K[it][0], "text": ITEM_8K[it][1], "filed": f["filed"],
                               "url": filing_url(sub["cik"], f["acc"], f.get("doc"))})
        elif f["form"].startswith(("SC 13D", "SCHEDULE 13D", "SC 13G", "SCHEDULE 13G")):
            holders.append({"form": f["form"], "filed": f["filed"], "url": filing_url(sub["cik"], f["acc"])})
        elif f["form"] in ("NT 10-K", "NT 10-Q"):
            ev.append({"item": "NT", "type": "late_filing", "text": f"{f['form']}: late filing notice", "filed": f["filed"],
                       "url": filing_url(sub["cik"], f["acc"])})
    return ev, holders


def run_scores(ctx: Ctx, master: dict, subs: dict, bars: dict, facts: dict, insiders: dict, inst: dict, macro: dict) -> dict:
    usdcad = macro.get("usdcad") or 1.36
    today = date.today().isoformat()
    sector_px = {sec: pxstats(bars[etf]["bars"]) for sec, etf in config.SECTOR_ETF.items() if etf in bars}
    bench = pxstats(bars["SPY"]["bars"]) if "SPY" in bars else {}
    rows = []
    for sid, s in master.items():
        if s["status"] != "active" or s["asset_type"] != "stock":
            continue
        lst = s["listings"][0]
        b = bars.get(lst["yahoo"])
        if not b or not b.get("bars"):
            continue
        px = pxstats(b["bars"])
        cur = b.get("currency") or lst["currency"]
        fx = 1 / usdcad if cur == "CAD" else 1.0
        cf = facts.get(s.get("cik") or "")
        snap = F.snapshot(cf) if cf else None
        stmt_cur = reporting_currency(cf)
        stmt_fx = {"USD": 1.0, "CAD": 1 / usdcad}.get(stmt_cur) if stmt_cur else 1.0
        m = MET.compute(snap, price=px["last"], splits=b.get("splits", []), bars=b["bars"], model=s["model"], price_fx=fx, stmt_fx=stmt_fx) if snap else {"mcap": None, "history": {}}
        m["reporting_currency"] = stmt_cur
        mcap = m.get("mcap") or ((s.get("screener") or {}).get("mcap"))
        price_usd = px["last"] * fx
        adv_usd = px["adv_usd_50"] * fx
        rows.append({"sid": sid, "s": s, "b": b, "px": px, "snap": snap, "m": m, "mcap": mcap, "price_usd": price_usd, "adv_usd": adv_usd,
                     "currency": cur, "cf": cf})
    log(f"scoring {len(rows)} stocks")
    sector_med = MET.peer_medians(rows, lambda r: r["s"].get("sector"))
    ind_med = MET.peer_medians(rows, lambda r: r["s"].get("industry"))
    # breadth: share of each sector's stocks above their 50-day average
    breadth: dict[str, list] = {}
    for r in rows:
        if r["px"].get("above_ma50") is not None and r["s"].get("sector"):
            breadth.setdefault(r["s"]["sector"], []).append(1 if r["px"]["above_ma50"] else 0)
    rot = MAC.rotation(sector_px, bench, {k: sum(v) / len(v) for k, v in breadth.items() if v})
    tilt = macro.get("sector_tilt", {})
    out_rows, details = [], {}
    for r in rows:
        s, px, m, snap = r["s"], r["px"], r["m"], r["snap"]
        E = config.ELIGIBILITY if (r["mcap"] or 0) >= config.ELIGIBILITY["min_mcap_usd"] else config.MICRO_EXPERIMENTAL
        elig_fail = []
        if (r["mcap"] or 0) < E["min_mcap_usd"] and not s.get("no_sec_filings"):
            elig_fail.append("market cap")  # TSX-only names have no verified share count; they're capped at 69 anyway
        if r["price_usd"] < E["min_price_usd"]:
            elig_fail.append("share price")
        if r["adv_usd"] < E["min_adv_usd"]:
            elig_fail.append("dollar volume")
        if px["days"] < E["min_history_days"]:
            elig_fail.append("trading history")
        if not s.get("cik") and not s.get("no_sec_filings"):
            elig_fail.append("identifier")
        if elig_fail:
            continue
        cap = M.cap_class(r["mcap"])
        sub = subs.get(s.get("cik") or "")
        events, holders13 = events_for(sub)
        ins = INS.summarize(insiders.get("by_cik", {}).get(s.get("cik") or "", []))
        ins["activist"] = [h for h in holders13 if h["form"].startswith(("SC 13D", "SCHEDULE 13D"))]
        inst_ch = (inst.get("by_security") or {}).get(r["sid"], [])
        dy = DIV.ttm_yield(r["b"].get("dividends", []), px["last"])
        verified = bool(snap and (snap.get("revenue") or snap.get("net_income")) and snap.get("assets"))
        filing_age = (date.today() - date.fromisoformat(snap["latest_filed"])).days if snap and snap.get("latest_filed") else None
        scr = s.get("screener") or {}
        ver = {
            "sec_financials": verified,
            "filing_age_days": filing_age,
            "price_fresh": (date.today() - date.fromisoformat(px["last_date"])).days <= 4,
            "mcap_confirmed": (abs(m["mcap"] / scr["mcap"] - 1) <= 0.1) if m.get("mcap") and scr.get("mcap") else None,
            "price_confirmed": (abs(px["last"] / scr["price"] - 1) <= 0.03) if scr.get("price") and r["currency"] == "USD" else None,
            "restated": bool(snap and any(isinstance(v, dict) and v.get("restated") for v in snap.values())),
        }
        liquid = r["adv_usd"] >= 250e3
        quarantined = RISK.quarantine(m, snap or {}, events, px, liquid) if snap else (["no verified financial statements"] if not s.get("no_sec_filings") else [])
        if s.get("no_sec_filings"):
            quarantined = []
        flags = RISK.review_flags(m, events, ins)
        comps = {
            "financial_health": RISK.health(m, s["model"]) if snap else SC.Component("financial_health", missing=["financial statements"]),
            "valuation": VAL.score(m, px, s["model"], sector_med.get(s.get("sector") or "", {}), ind_med.get(s.get("industry") or "", {}))[0] if snap else SC.Component("valuation", missing=["financial statements"]),
            "institutional": INST.score(inst_ch, holders13),
            "growth_catalysts": GROW.score(m, events) if snap else SC.Component("growth_catalysts", missing=["financial statements"]),
            "market_sector": SC.market_sector(px, s.get("sector"), rot, tilt),
            "insider_strategic": INS.score(ins),
            "data_quality": SC.data_quality(ver),
            "income_quality": DIV.score(m, dy, s["model"]),
        }
        profiles = SC.choose_profiles(m, dy)
        results = {p: SC.combine(comps, p, verified_financials=verified, quarantined=quarantined) for p in profiles}
        best = max(results.values(), key=lambda x: x["score"])
        conf = CONF.score(snap, ver)
        risk_label = RISK.label(m, px, s["model"], flags, quarantined)
        scen = RISK.scenarios(m, s["model"], sector_med.get(s.get("sector") or "", {}), ind_med.get(s.get("industry") or "", {})) if snap else {"available": False, "why": "no verified financials"}
        experimental = cap == "micro"
        row = {
            "id": r["sid"], "ticker": s["ticker"], "name": s["name"], "exchange": s["exchange"], "country": s["country"],
            "currency": r["currency"], "sector": s.get("sector"), "industry": s.get("industry"), "model": s["model"],
            "cap": cap, "experimental": experimental, "mcap": r["mcap"], "price": px["last"], "price_date": px["last_date"],
            "off_high": px.get("off_high"), "ret_3m": px.get("ret_3m"), "ret_1y": px.get("ret_1y"),
            "score": best["score"], "class": best["class"], "profile": best["profile"],
            "scores": {p: v["score"] for p, v in results.items()}, "confidence": conf["confidence"], "risk": risk_label,
            "quarantined": bool(quarantined), "flags": len(flags), "yield": dy.get("yield"),
            "pe": m.get("pe"), "ev_ebitda": m.get("ev_ebitda"), "fcf_yield": m.get("fcf_yield"), "rev_growth": m.get("rev_growth"),
            "insider_buyers_90d": ins.get("buyers_90d", 0), "inst_adds": len({c["manager"] for c in inst_ch if c["change"] in ("new", "increase")}),
            "upside": scen.get("upside_base") if scen.get("available") else None, "reward_risk": scen.get("reward_risk") if scen.get("available") else None,
            "verified": verified, "dual_listed": len(s["listings"]) > 1,
        }
        out_rows.append(row)
        details[r["sid"]] = {
            "row": row, "security": {k: v for k, v in s.items() if k != "screener"},
            "metrics": {k: v for k, v in m.items() if k not in ("history",)}, "history_multiples": m.get("history"),
            "price_stats": px, "results": results, "best_profile": best["profile"], "why": SC.why_flagged(best),
            "confidence": conf, "risk": {"label": risk_label, "quarantine": quarantined, "review": flags}, "scenarios": scen,
            "dividends": {k: v for k, v in dy.items() if k != "per_year"} | {"history": r["b"].get("dividends", [])[-24:]},
            "insider": ins, "institutional": inst_ch, "holders_13dg": holders13, "events": events,
            "sources": sources_for(s, snap, r, ver),
            "statements": statements_view(snap) if snap else None,
            "chart": [[x["t"], round(x["c"], 4)] for x in r["b"]["bars"][-260:]],
            "verification": ver, "eligibility": "experimental microcap" if experimental else "standard",
        }
    return {"rows": out_rows, "details": details, "rotation": rot, "sector_medians": sector_med}


def reporting_currency(cf: dict | None) -> str | None:
    if not cf:
        return None
    for k in ("revenue", "net_income", "assets", "equity"):
        u = (cf.get(k) or {}).get("unit")
        if u:
            return u.split("/")[0]
    return None


def sources_for(s, snap, r, ver) -> list[dict]:
    src = []
    if snap:
        for k in ("revenue", "net_income", "ocf", "cash", "equity", "shares_outstanding"):
            v = snap.get(k)
            if v and v.get("accn"):
                src.append(store.source("SEC EDGAR XBRL", filing_url(s["cik"], v["accn"]), reliability="primary", publication_date=v.get("filed"),
                                        reporting_period=f"{v.get('start') or ''}→{v.get('end')}".lstrip("→")) | {"field": k, "concept": v.get("concept"), "form": v.get("form")})
    src.append(store.source("Yahoo Finance (delayed)", f"https://finance.yahoo.com/quote/{s['listings'][0]['yahoo']}", reliability="market_data",
                            event_date=r["px"].get("last_date"), verification="delayed") | {"field": "price"})
    return src


def statements_view(snap: dict) -> dict:
    keep = {}
    for k in ("revenue", "net_income", "operating_income", "ocf", "capex", "cash", "equity", "assets", "shares_outstanding", "eps_diluted", "dividends_paid", "interest_expense"):
        v = snap.get(k)
        if v:
            keep[k] = {kk: v.get(kk) for kk in ("value", "start", "end", "filed", "form", "accn", "basis", "concept", "restated")}
    keep["debt_total"] = F.total_debt(snap)
    keep["annual_revenue"] = snap.get("revenue_annual", [])[-6:]
    keep["annual_net_income"] = snap.get("net_income_annual", [])[-6:]
    keep["annual_ocf"] = snap.get("ocf_annual", [])[-6:]
    keep["latest_filed"] = snap.get("latest_filed")
    keep["going_concern"] = snap.get("going_concern")
    return keep


def run_etfs(bars: dict) -> list[dict]:
    out = []
    for t, label in config.ETFS.items():
        b = bars.get(t)
        if not b:
            out.append({"ticker": t, "label": label, "available": False})
            continue
        px = pxstats(b["bars"])
        a = ETF.analyze(b["bars"], b.get("dividends", []), px)
        sc, comps, conf = ETF.score(a, label)
        out.append({"id": f"ETF-{t}", "ticker": t, "label": label, "currency": b.get("currency"), "price": px.get("last"), "price_date": px.get("last_date"),
                    "score": sc, "confidence": conf, "components": comps, **{k: v for k, v in a.items() if k != "dividend"},
                    "chart": [[x["t"], round(x["c"], 4)] for x in b["bars"][-260:]]})
    return out
