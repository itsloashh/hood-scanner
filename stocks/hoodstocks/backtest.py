"""Point-in-time backtest of the deterministic score.

At each quarter-end we rebuild every company's fundamentals from only the filings that had been FILED by that date,
use prices on or before that date, score them, and measure the next 3 and 6 months of dividend-adjusted return for
each score bucket against SPY.

Known limits (reported with the results): the universe is today's listed companies (survivorship bias — delisted names
are missing from the free data), and insider/13F/sector components are excluded because their history isn't stored yet."""
from __future__ import annotations

from datetime import date

from . import fundamentals as F, metrics as MET, store
from .engines import growth as GROW, risk as RISK, value as VAL
from .prices import close_on, forward_return, stats as pxstats

WEIGHTS = {"financial_health": 35, "valuation": 40, "growth_catalysts": 25}  # only the components with point-in-time history


def quarter_ends(years: int = 4) -> list[str]:
    today = date.today()
    out = []
    for y in range(today.year - years, today.year + 1):
        for m, d in ((3, 31), (6, 30), (9, 30), (12, 31)):
            q = date(y, m, d)
            if q.toordinal() < today.toordinal() - 100:
                out.append(q.isoformat())
    return out


def run(master: dict, facts: dict, bars: dict) -> dict:
    spy = bars.get("SPY")
    dates = quarter_ends()
    buckets: dict[str, dict[str, list]] = {}
    per_date = []
    for as_of in dates:
        scored = []
        for s in master.values():
            if s.get("asset_type") != "stock" or not s.get("cik") or s.get("share_class_of"):
                continue
            cf, b = facts.get(s["cik"]), bars.get(s["listings"][0]["yahoo"])
            if not cf or not b or not b.get("bars") or b["bars"][0]["t"] > as_of:
                continue
            px_bars = [x for x in b["bars"] if x["t"] <= as_of]
            if len(px_bars) < 120:
                continue
            snap = F.snapshot(cf, as_of=as_of)
            if not snap.get("revenue") and not snap.get("net_income"):
                continue
            price = close_on(b["bars"], as_of)
            m = MET.compute(snap, price=price, splits=b.get("splits", []), bars=px_bars, model=s["model"])
            if not m.get("mcap") or m["mcap"] < 300e6:
                continue
            px = pxstats(px_bars)
            comps = {"financial_health": RISK.health(m, s["model"]), "valuation": VAL.score(m, px, s["model"], {}, {})[0], "growth_catalysts": GROW.score(m, [])}
            score = sum(comps[k].earned * w for k, w in WEIGHTS.items())
            r3, r6 = forward_return(b["bars"], as_of, 91), forward_return(b["bars"], as_of, 182)
            scored.append((score, r3, r6))
        if not scored or not spy:
            continue
        b3, b6 = forward_return(spy["bars"], as_of, 91), forward_return(spy["bars"], as_of, 182)
        per_date.append({"date": as_of, "n": len(scored), "spy_3m": b3, "spy_6m": b6})
        for score, r3, r6 in scored:
            k = "70+" if score >= 70 else "60–69" if score >= 60 else "50–59" if score >= 50 else "40–49" if score >= 40 else "<40"
            bk = buckets.setdefault(k, {"r3": [], "x3": [], "r6": [], "x6": []})
            if r3 is not None and b3 is not None:
                bk["r3"].append(r3)
                bk["x3"].append(r3 - b3)
            if r6 is not None and b6 is not None:
                bk["r6"].append(r6)
                bk["x6"].append(r6 - b6)
    avg = lambda xs: sum(xs) / len(xs) if xs else None  # noqa: E731
    res = {
        "updated": store.now_iso(), "dates": per_date, "weights": WEIGHTS,
        "buckets": {k: {"n": len(v["r3"]), "avg_3m": avg(v["r3"]), "excess_3m": avg(v["x3"]), "hit_3m": avg([1 if x > 0 else 0 for x in v["x3"]]),
                        "avg_6m": avg(v["r6"]), "excess_6m": avg(v["x6"])} for k, v in buckets.items()},
        "limits": ["Survivorship bias: only companies listed today are included (free data has no delisted universe).",
                   "Only financial health, valuation (vs own history) and growth are replayed; insider, 13F, sector and peer comparisons are not.",
                   "Fundamentals are point-in-time by filing date; prices are dividend-adjusted closes; no transaction costs applied here."],
    }
    store.write("backtest.json", res)
    return res
