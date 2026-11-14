"""Provider capability registry: what each source gives us, its limits, and whether it worked this run.
Unavailable sources are listed explicitly instead of being silently skipped."""
from __future__ import annotations

from ..store import now_iso

PROVIDERS: dict[str, dict] = {
    "sec_edgar": {
        "name": "SEC EDGAR (submissions, XBRL company facts, Form 4, 13F, 8-K)",
        "kind": "primary regulatory", "key": None, "cost": "free",
        "coverage": "US issuers + Canadian/foreign issuers that file with the SEC (40-F, 20-F, 6-K)",
        "freshness": "filings appear minutes after acceptance; 13F is quarterly and up to 45 days after quarter end",
        "limits": "10 requests/second, must send an identifying User-Agent",
        "licensing": "public domain US government data",
    },
    "yahoo": {
        "name": "Yahoo Finance chart API",
        "kind": "market data (supplementary)", "key": None, "cost": "free, unofficial",
        "coverage": "US + TSX (.TO) prices, dividends, splits",
        "freshness": "delayed; daily bars used",
        "limits": "unpublished; throttled to ~3/s",
        "licensing": "personal research use only; not licensed real-time data; may change without notice",
    },
    "fred": {
        "name": "FRED (St. Louis Fed)", "kind": "official statistics", "key": None, "cost": "free",
        "coverage": "US rates, inflation, jobs, GDP, credit spreads, commodities, USD/CAD",
        "freshness": "per release schedule", "limits": "keyless CSV download", "licensing": "public, cite source",
    },
    "bank_of_canada": {
        "name": "Bank of Canada Valet API", "kind": "official statistics", "key": None, "cost": "free",
        "coverage": "policy rate, CAD FX, Canadian yields", "freshness": "daily", "limits": "none published", "licensing": "open",
    },
    "openfigi": {
        "name": "OpenFIGI mapping", "kind": "identifier mapping", "key": "OPENFIGI_API_KEY (optional, raises limits)", "cost": "free",
        "coverage": "CUSIP → ticker/FIGI for 13F holdings", "freshness": "static", "limits": "25 requests/min keyless", "licensing": "open",
    },
    "google_news": {
        "name": "Google News RSS (discovery only)", "kind": "news aggregator", "key": None, "cost": "free",
        "coverage": "headlines + links; facts must be verified against filings", "freshness": "minutes",
        "limits": "throttled", "licensing": "headlines and links only; articles are not copied",
    },
    # ── Not available for free / blocked in V1 ─────────────────────
    "sedar_plus": {
        "name": "SEDAR+ (Canadian filings)", "kind": "primary regulatory", "status": "blocked",
        "why": "no public API; terms prohibit automated scraping. Canadian issuers that also file with the SEC are covered through EDGAR.",
    },
    "sedi": {
        "name": "SEDI (Canadian insider trades)", "kind": "primary regulatory", "status": "blocked",
        "why": "no public API; terms prohibit automated access.",
    },
    "political": {
        "name": "US congressional trade disclosures", "kind": "official disclosure", "status": "blocked",
        "why": "House PTRs are scanned PDFs and the Senate eFD site requires an interactive agreement; needs a PDF/OCR pipeline (planned).",
    },
    "etf_flows": {
        "name": "ETF fund flows / AUM / holdings", "kind": "market data", "status": "blocked",
        "why": "no free official feed; N-PORT holdings are quarterly and heavy. V1 analyses ETFs from price and distributions only.",
    },
    "llm": {
        "name": "AI research summaries", "kind": "LLM", "status": "blocked", "key": "ANTHROPIC_API_KEY",
        "why": "needs a paid API key. All scores and numbers are deterministic and don't depend on it.",
    },
    "real_time_quotes": {
        "name": "Licensed real-time quotes", "kind": "market data", "status": "blocked",
        "why": "paid. Prices are delayed daily bars, labelled as such.",
    },
}


def snapshot(http_health: dict, used: dict[str, list[str]]) -> dict:
    """used: provider -> list of hosts it called this run. Status from the HTTP stats."""
    out = {}
    for pid, meta in PROVIDERS.items():
        row = dict(meta)
        if meta.get("status") == "blocked":
            out[pid] = row
            continue
        hosts = used.get(pid, [])
        hs = [http_health[h] for h in hosts if h in http_health]
        if not hs:
            row["status"] = "not used this run"
        else:
            ok = sum(h["ok"] + h.get("cache_hits", 0) for h in hs)
            err = sum(h["errors"] for h in hs)
            row["status"] = "ok" if err == 0 else ("degraded" if ok > err else "down")
            row["calls"] = sum(h["calls"] for h in hs)
            row["errors"] = err
            row["last_error"] = next((h["last_error"] for h in hs if h.get("last_error")), None)
        row["checked"] = now_iso()
        out[pid] = row
    return out
