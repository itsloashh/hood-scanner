"""All tunable settings in one place. Thresholds are defaults from the V1 spec; change here, not in code."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # repo root
DATA = Path(os.environ.get("STOCKS_DATA_DIR", ROOT / "data" / "stocks"))
CACHE = Path(os.environ.get("STOCKS_CACHE_DIR", ROOT / ".cache" / "stocks"))  # not committed (actions/cache)

SCORE_VERSION = "1.0.0"

# SEC asks every client to identify itself. Set the SEC_USER_AGENT secret to "Name contact@example.com".
SEC_USER_AGENT = os.environ.get("SEC_USER_AGENT") or "HoodDesk research bot (github.com/itsloashh/hood-scanner)"
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

# Requests per second per host (SEC's published limit is 10/s; we stay under it)
RATE = {
    "www.sec.gov": 6.0,
    "data.sec.gov": 6.0,
    "query1.finance.yahoo.com": 3.0,
    "query2.finance.yahoo.com": 3.0,
    "fred.stlouisfed.org": 2.0,
    "www.bankofcanada.ca": 2.0,
    "api.openfigi.com": 0.4,  # keyless: 25 requests / minute
    "news.google.com": 1.0,
    "api.telegram.org": 1.0,
}

# ── Market cap classes (USD) ─────────────────────────────
MICRO_MAX = 300e6
SMALL_MAX = 2e9
MID_MAX = 10e9

# ── Standard eligibility (stocks) ────────────────────────
ELIGIBILITY = {
    "min_mcap_usd": 300e6,
    "min_price_usd": 5.0,
    "min_adv_usd": 2e6,  # average daily dollar volume, 50 sessions
    "min_history_days": 90,
}
# Microcaps are tracked in a separate experimental list, never in the main rankings
MICRO_EXPERIMENTAL = {"min_mcap_usd": 50e6, "min_price_usd": 1.0, "min_adv_usd": 250e3, "min_history_days": 90}

US_EXCHANGES = {"NYSE", "Nasdaq", "CBOE", "NYSE American", "NYSE Arca"}

# Canadian SEC filers: EDGAR state-of-incorporation codes for provinces/territories and federal
CANADA_CODES = {"A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "B0", "Z4"}

# ── Discovery signals ───────────────────────────────────
VALUE = {"min_drawdown_52w": 0.15}
DIVIDEND = {"yield_min": 0.025, "yield_max": 0.08, "investigate_above": 0.10, "min_years": 5, "max_payout": 0.75}

# ── Scoring ─────────────────────────────────────────────
BASE_WEIGHTS = {
    "financial_health": 20,
    "valuation": 20,
    "institutional": 15,
    "growth_catalysts": 15,
    "market_sector": 10,
    "insider_strategic": 10,
    "data_quality": 10,
}
# Profiles re-weight the same components (each sums to 100)
PROFILES = {
    "value": {"financial_health": 22, "valuation": 28, "institutional": 15, "growth_catalysts": 8, "market_sector": 7, "insider_strategic": 10, "data_quality": 10},
    "growth": {"financial_health": 20, "valuation": 12, "institutional": 13, "growth_catalysts": 28, "market_sector": 9, "insider_strategic": 8, "data_quality": 10},
    "dividend": {"financial_health": 25, "valuation": 18, "institutional": 10, "growth_catalysts": 7, "market_sector": 5, "insider_strategic": 5, "data_quality": 10, "income_quality": 20},
}
# dividend profile has an extra component; rescale so it sums to 100
_d = PROFILES["dividend"]
_s = sum(_d.values())
PROFILES["dividend"] = {k: round(v * 100 / _s, 2) for k, v in _d.items()}

CLASSES = [(90, "Exceptional research candidate"), (80, "Strong research candidate"), (70, "Developing opportunity"), (60, "Early watchlist"), (0, "No priority alert")]

CAPS = {
    "no_verified_financials": 69,
    "institutional_only": 79,
}

ALERT = {
    "opportunity_min_score": 70,
    "opportunity_min_confidence": 50,
    "rescore_jump": 10,  # a new alert for the same name needs +10 points AND a class upgrade
    "insider_min_value_usd": 100_000,
    "insider_cluster_min_people": 2,
    "max_alerts_per_run": 8,
}

# Curated fundamental managers whose 13F filings we compare quarter to quarter (CIKs from EDGAR).
# Quant/multi-strategy funds (thousands of positions, high turnover) are left out on purpose: their changes are noise.
# A CIK whose EDGAR name doesn't match the label, or with no 13F in 200 days, is skipped and reported.
MANAGERS = {
    "1067983": "Berkshire Hathaway",
    "1336528": "Pershing Square",
    "1061768": "Baupost Group",
    "1649339": "Scion Asset Management",
    "1029160": "Soros Fund Management",
    "1167483": "Tiger Global",
    "1103804": "Viking Global",
    "1135730": "Coatue Management",
    "1656456": "Appaloosa",
    "1040273": "Third Point",
    "1079114": "Greenlight Capital",
    "1418814": "ValueAct",
    "1345471": "Trian Fund Management",
    "1510387": "Starboard Value",
    "1647251": "TCI Fund Management",
    "1112520": "Akre Capital",
    "921669": "Icahn Capital",
    "1096343": "Markel Group",
    "1279708": "Fairfax Financial",
    "1061165": "Lone Pine Capital",
    "1056831": "Fairholme",
}

# ETFs analysed (US + Canada). Sector ETFs double as the sector-rotation gauge.
ETFS = {
    "SPY": "S&P 500", "QQQ": "Nasdaq 100", "IWM": "Russell 2000", "VTI": "US total market",
    "SCHD": "US dividend", "VYM": "US high dividend", "DGRO": "US dividend growth", "JEPI": "Covered-call (S&P)",
    "TLT": "Long Treasuries", "HYG": "High-yield bonds", "GLD": "Gold",
    "XLK": "Technology", "XLF": "Financials", "XLE": "Energy", "XLV": "Health care", "XLI": "Industrials",
    "XLY": "Consumer discretionary", "XLP": "Consumer staples", "XLU": "Utilities", "XLB": "Materials",
    "XLRE": "Real estate", "XLC": "Communication services",
    "XIC.TO": "TSX composite", "XIU.TO": "TSX 60", "VDY.TO": "Canadian high dividend", "XEI.TO": "Canadian dividend",
    "ZEB.TO": "Canadian banks", "XEG.TO": "Canadian energy", "ZWC.TO": "Canadian covered-call", "XRE.TO": "Canadian REITs",
}
SECTOR_ETF = {
    "Technology": "XLK", "Financials": "XLF", "Energy": "XLE", "Health Care": "XLV", "Industrials": "XLI",
    "Consumer Discretionary": "XLY", "Consumer Staples": "XLP", "Utilities": "XLU", "Materials": "XLB",
    "Real Estate": "XLRE", "Communication Services": "XLC",
}
BENCHMARK = {"US": "SPY", "CA": "XIC.TO"}

# Extra TSX-only tickers to price (no SEC filings → no verified financials → scores capped at 69)
TSX_EXTRA = ["CNR.TO", "CP.TO", "ATD.TO", "BN.TO", "TRI.TO", "WCN.TO", "L.TO", "DOL.TO", "MRU.TO", "EMA.TO", "FTS.TO", "T.TO", "BCE.TO", "POW.TO", "IFC.TO", "SLF.TO", "MFC.TO", "GWO.TO", "NA.TO", "CM.TO", "BNS.TO", "BMO.TO", "TD.TO", "RY.TO"]
