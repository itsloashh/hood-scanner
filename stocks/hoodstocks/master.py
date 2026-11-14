"""Security master: one canonical record per security, never keyed by ticker alone.

security_id rules
  US/CA SEC filers:  "SEC{cik}"            (primary share class)
                     "SEC{cik}-{TICKER}"   (each additional share class, e.g. GOOG vs GOOGL)
  TSX-only names:    "TSX-{TICKER}"        (no SEC filings → no verified financials)
  ETFs:              "ETF-{TICKER}"
Listings hang off the security: a Canadian company can have a TSX listing (CAD) and a NYSE listing (USD).
Ticker changes are detected against the previous master and written to ticker_history.jsonl."""
from __future__ import annotations

import json
from dataclasses import dataclass

from . import config, store
from .providers.sec import Sec

# SIC → (sector name, valuation model). Sector names match config.SECTOR_ETF keys.
def sic_profile(sic: int | None) -> tuple[str | None, str]:
    if not sic:
        return None, "general"
    s = int(sic)
    if s in (6021, 6022, 6029, 6035, 6036) or 6020 <= s <= 6029 or s in (6111, 6120):
        return "Financials", "bank"
    if 6311 <= s <= 6411:
        return "Financials", "insurance"
    if s == 6798:
        return "Real Estate", "reit"
    if 6500 <= s <= 6553:
        return "Real Estate", "general"
    if 6000 <= s <= 6799:
        return "Financials", "financial"
    if 4900 <= s <= 4991:
        return "Utilities", "utility"
    if s in (1311, 1381, 1382, 1389, 2911, 4922, 4923, 4924, 5171, 5172, 1221, 1222):
        return "Energy", "energy"
    if 3570 <= s <= 3579 or 3670 <= s <= 3679 or 7370 <= s <= 7379 or s in (3661, 3663, 3669, 3825, 3826):
        return "Technology", "tech"
    if 2830 <= s <= 2836 or 3841 <= s <= 3851 or 8000 <= s <= 8099 or s == 5122:
        return "Health Care", "general"
    if 4800 <= s <= 4899 or 2711 <= s <= 2741 or 7810 <= s <= 7829:
        return "Communication Services", "general"
    if 1000 <= s <= 1499 or 2600 <= s <= 2699 or 2800 <= s <= 2829 or 2840 <= s <= 2899 or 3300 <= s <= 3399:
        return "Materials", "general"
    if 2000 <= s <= 2199 or 5400 <= s <= 5499 or s in (2840, 2844, 5141, 5149, 5912):
        return "Consumer Staples", "general"
    if 5000 <= s <= 5999 or 7000 <= s <= 7099 or 2300 <= s <= 2399 or 3711 <= s <= 3716 or 5800 <= s <= 5899 or 7900 <= s <= 7999:
        return "Consumer Discretionary", "general"
    if 1500 <= s <= 1799 or 3400 <= s <= 3569 or 3580 <= s <= 3669 or 3700 <= s <= 3799 or 4000 <= s <= 4799 or 8700 <= s <= 8748:
        return "Industrials", "general"
    return None, "general"


NASDAQ_SECTOR = {
    "Technology": "Technology", "Finance": "Financials", "Health Care": "Health Care", "Energy": "Energy",
    "Industrials": "Industrials", "Consumer Discretionary": "Consumer Discretionary", "Consumer Staples": "Consumer Staples",
    "Utilities": "Utilities", "Real Estate": "Real Estate", "Basic Materials": "Materials", "Telecommunications": "Communication Services",
}

US_STATES = set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split())


def country_of(sub: dict) -> str:
    """US / CA / OTHER from SEC business address, falling back to state of incorporation."""
    addr = ((sub.get("addresses") or {}).get("business") or {})
    code = (addr.get("stateOrCountry") or "").upper()
    inc = (sub.get("stateOfIncorporation") or "").upper()
    if code in config.CANADA_CODES:
        return "CA"
    if code in US_STATES:
        return "US"
    if inc in config.CANADA_CODES and not code:
        return "CA"
    return "OTHER"


def cap_class(mcap_usd: float | None) -> str | None:
    if mcap_usd is None:
        return None
    if mcap_usd < config.MICRO_MAX:
        return "micro"
    if mcap_usd < config.SMALL_MAX:
        return "small"
    if mcap_usd < config.MID_MAX:
        return "mid"
    return "large"


def summarize_submissions(sub: dict) -> dict:
    """Keep only what we use from an EDGAR submissions file (they can be several MB)."""
    r = (sub.get("filings") or {}).get("recent") or {}
    keep = {"10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "40-F", "6-K", "8-K", "8-K/A", "SC 13D", "SC 13D/A", "SCHEDULE 13D", "SCHEDULE 13D/A",
            "SC 13G", "SCHEDULE 13G", "NT 10-K", "NT 10-Q", "S-1", "S-3", "424B5", "DEF 14A", "4"}
    filings = []
    for i, form in enumerate(r.get("form", [])):
        if form not in keep:
            continue
        filings.append({
            "form": form,
            "filed": r["filingDate"][i],
            "report": (r.get("reportDate") or [None] * (i + 1))[i] or None,
            "acc": r["accessionNumber"][i],
            "doc": (r.get("primaryDocument") or [None] * (i + 1))[i],
            "items": (r.get("items") or [""] * (i + 1))[i] or "",
        })
        if len(filings) >= 400:
            break
    return {
        "cik": str(int(sub.get("cik"))),
        "name": sub.get("name"),
        "sic": int(sub["sic"]) if str(sub.get("sic") or "").isdigit() else None,
        "sic_desc": sub.get("sicDescription"),
        "country": country_of(sub),
        "state_inc": sub.get("stateOfIncorporation"),
        "category": sub.get("category"),
        "fiscal_year_end": sub.get("fiscalYearEnd"),
        "tickers": sub.get("tickers") or [],
        "exchanges": sub.get("exchanges") or [],
        "former_names": [f.get("name") for f in (sub.get("formerNames") or [])],
        "entity_type": sub.get("entityType"),
        "filings": filings,
    }


@dataclass
class MasterInputs:
    sec_rows: list[dict]          # Sec.tickers()
    screener: dict[str, dict]     # ticker -> nasdaq row
    subs: dict[str, dict]         # cik -> summarize_submissions()


def build(inp: MasterInputs) -> dict[str, dict]:
    by_cik: dict[str, list[dict]] = {}
    for r in inp.sec_rows:
        if r.get("exchange") not in config.US_EXCHANGES:
            continue
        by_cik.setdefault(str(r["cik"]), []).append(r)
    out: dict[str, dict] = {}
    for cik, rows in by_cik.items():
        sub = inp.subs.get(cik)
        if not sub:
            continue
        # primary class = the most traded ticker
        rows = sorted(rows, key=lambda r: -((inp.screener.get(r["ticker"]) or {}).get("volume") or 0) * ((inp.screener.get(r["ticker"]) or {}).get("price") or 0))
        sector, model = sic_profile(sub.get("sic"))
        for n, r in enumerate(rows):
            t = r["ticker"].upper()
            scr = inp.screener.get(t) or {}
            sid = f"SEC{cik}" if n == 0 else f"SEC{cik}-{t}"
            out[sid] = {
                "security_id": sid,
                "ticker": t,
                "name": r.get("name") or sub.get("name"),
                "cik": cik,
                "exchange": r.get("exchange"),
                "country": sub["country"],
                "currency": "USD",
                "asset_type": "stock",
                "share_class_of": f"SEC{cik}" if n else None,
                "sector": sector or NASDAQ_SECTOR.get(scr.get("sector") or ""),
                "industry": scr.get("industry") or sub.get("sic_desc"),
                "sic": sub.get("sic"),
                "model": model,
                "listings": [{"ticker": t, "exchange": r.get("exchange"), "currency": "USD", "yahoo": t.replace(".", "-")}],
                "identifiers": {"cik": cik, "figi": None, "cusip": None, "isin": None},
                "former_names": sub.get("former_names", []),
                "status": "active",
                "screener": {"price": scr.get("price"), "mcap": scr.get("mcap"), "volume": scr.get("volume")},
            }
    return out


def add_etfs(master: dict) -> None:
    for t, label in config.ETFS.items():
        cad = t.endswith(".TO")
        master[f"ETF-{t}"] = {
            "security_id": f"ETF-{t}", "ticker": t, "name": label, "cik": None,
            "exchange": "TSX" if cad else "US", "country": "CA" if cad else "US", "currency": "CAD" if cad else "USD",
            "asset_type": "etf", "sector": None, "industry": label, "model": "etf",
            "listings": [{"ticker": t, "exchange": "TSX" if cad else "US", "currency": "CAD" if cad else "USD", "yahoo": t}],
            "identifiers": {}, "status": "active",
        }


def add_tsx_only(master: dict, existing_tsx: set[str]) -> None:
    for t in config.TSX_EXTRA:
        if t in existing_tsx:
            continue
        master[f"TSX-{t}"] = {
            "security_id": f"TSX-{t}", "ticker": t, "name": None, "cik": None, "exchange": "TSX", "country": "CA", "currency": "CAD",
            "asset_type": "stock", "sector": None, "industry": None, "model": "general",
            "listings": [{"ticker": t, "exchange": "TSX", "currency": "CAD", "yahoo": t}],
            "identifiers": {}, "status": "active", "no_sec_filings": True,
        }


def ticker_changes(old: dict, new: dict) -> list[dict]:
    """Same security_id, different ticker → a ticker change."""
    ch = []
    for sid, s in new.items():
        o = old.get(sid)
        if o and o.get("ticker") != s.get("ticker"):
            ch.append({"security_id": sid, "from": o.get("ticker"), "to": s.get("ticker"), "detected": store.now_iso()})
    return ch


def resolve(master: dict, query: str) -> dict:
    """Ticker / name → {match} or {ambiguous: [...]} or {none}. Never guesses between two different securities."""
    q = query.strip().upper().lstrip("$")
    exact = [s for s in master.values() if any(l["ticker"].upper() == q or l.get("yahoo", "").upper() == q for l in s.get("listings", []))]
    if len({s["security_id"] for s in exact}) == 1:
        return {"match": exact[0]}
    if len(exact) > 1:
        return {"ambiguous": [{"security_id": s["security_id"], "ticker": s["ticker"], "exchange": s["exchange"], "name": s["name"]} for s in exact]}
    base = q.split(".")[0]
    cands = [s for s in master.values() if s["ticker"].split(".")[0].upper() == base]
    if len(cands) == 1:
        return {"match": cands[0]}
    if cands:
        return {"ambiguous": [{"security_id": s["security_id"], "ticker": s["ticker"], "exchange": s["exchange"], "name": s["name"]} for s in cands]}
    return {"none": True}


def compact(master: dict) -> str:
    return json.dumps(master, separators=(",", ":"))
