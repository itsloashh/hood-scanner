# Hood Desk — stock research engine (V1)

Finds US and Canadian stocks where fundamentals, valuation, insider/institutional activity, catalysts and the economy
start lining up, and explains every point. **Research only: no trading, no brokerage, no orders.**

Results show up in the Hood Desk dashboard (Stocks tab) and as Telegram alerts through the existing Hood Scanner bot.

## How it runs (free)

| Piece | Where | Schedule |
|---|---|---|
| Daily research run | GitHub Actions `stocks.yml`, mode `daily` | weekdays 22:35 UTC (≈ 5:35 PM Toronto) |
| Insider (Form 4) sweep | same workflow, mode `insiders` | every 2 h on weekdays |
| 13F comparison | inside `daily` on Mondays (or mode `institutions`) | weekly |
| Backtest | mode `backtest` (manual) | on demand |
| Dashboard | Next.js on Vercel (`dashboard/`), reads `data/stocks/*` from this repo | live |

The V1 spec asked for FastAPI + Postgres + Redis + Celery + Docker. Those need a paid always-on server, so V1 uses the
setup that already runs the memecoin bot for free: a Python job on GitHub Actions, JSON/JSONL files in the repo as the
database (every record keeps its source and filing date; history files are append-only), Actions cache for raw data,
Telegram for alerts and the dashboard as the interface. The engine modules don't depend on that choice — moving to
Postgres later means swapping `store.py`.

Run manually: GitHub → Actions → **stocks** → Run workflow → mode. Locally: `cd stocks && python -m hoodstocks.run daily`.
Tests: `cd stocks && pip install pytest && python -m pytest` (43 tests, synthetic data only).

## Modules (`hoodstocks/`)

| Module | Job |
|---|---|
| `http.py` | one client: per-host throttling, retries with exponential backoff, circuit breaker, health stats |
| `providers/` | adapters — `sec` (EDGAR), `yahoo`, `nasdaq` (discovery list), `macro` (FRED, Bank of Canada), `news`, `openfigi`, `telegram`, `registry` (capabilities + live status) |
| `master.py` | security master: IDs from SEC CIK (never ticker), share classes, US/CA detection, verified TSX dual listings, ticker-change history, ambiguity-safe resolution |
| `fundamentals.py` | XBRL company facts → TTM/annual/balance items with accession, filing date and restatement flags; point-in-time by filing date |
| `prices.py` | returns, 52-week range, liquidity, volatility, drawdown, split handling |
| `metrics.py` | ratios with separate price/statement FX (CAD reporters), historical multiples, sector/industry medians |
| `engines/` | `value`, `growth`, `dividend`, `etf`, `institutional`, `insider`, `risk` (health, quarantine, flags, label, scenarios), `macro`, `scoring`, `confidence` |
| `alerts.py` | dedupe keys, opportunity / insider / institutional / catalyst / risk alerts, daily digest |
| `history.py` | candidate record at discovery, 30/90/180/365-day + total returns vs benchmark, drawdown |
| `backtest.py` | quarterly point-in-time replay of the score |
| `pipeline.py`, `run.py` | orchestration; every stage fails soft and is reported in `health.json` |

## Options setups (calls only, V1)

`hoodstocks/options.py`, run after the daily scoring and re-priced at 10:45 AM and 1:45 PM Toronto on weekdays.

- **Gate:** US stock, score 60+, evidence 75+, market cap $1B+, swing zones with TP1 reward/risk ≥ 1.2.
- **Chains:** Cboe delayed quotes (~15 min) for the best ~60 by score + timing; Nasdaq earnings calendar.
- **Expiry:** 35–55 days, closest to 45; exit by 21 days left.
- **Structure:** call debit spread (buy ~0.60 delta, sell the strike nearest TP2) whenever IV > 1.05× realised volatility or
  earnings fall before expiry. A plain ~0.60-delta call only when IV ≤ 1.0× realised, no earnings, a very liquid contract
  (spread ≤ 5%, OI 1,000+) and the setup is Tier A as a call.
- **Liquidity:** open interest 150+, a bid, bid/ask spread ≤ 10% of mid.
- **Payoff:** Black-Scholes value if price hits TP1 / TP2 / the stop halfway to expiry, entry at the ask.
- **Tier:** points for score, evidence, uptrend, in-zone, RSI, option reward/risk, TP1 inside the implied move, cheap IV,
  liquidity, insider/fund activity; minus for stretched price, overbought, expensive IV, earnings in the window.
  A ≥ 10, B ≥ 8, C ≥ 5. A/B are alerted (max 3 per run, once per stock per 2 weeks) and paper-tracked at Cboe bid/ask — only
  when the stock itself is Opportunity-grade (score 72+, confidence 55+, quality overlay) or scores 80+.
- Files: `data/stocks/options/setups.json`, `paper.json`, `iv_history.json` (builds IV rank), `earnings.json`.

## Scoring (method v1.0.0)

Components (base weights): financial health 20 · undervaluation 20 · institutional 15 · growth & catalysts 15 ·
market & sector 10 · insider & strategic 10 · data quality 10. Profiles re-weight them: **value**, **growth**,
**dividend** (adds income quality). Each stock is scored through every lens that applies; growth companies are never
judged on dividends and non-payers skip the dividend lens. ETFs have their own profile.

Hard rules: missing or unverified data earns no points · no verified financials → max 69 · a case resting on
institutional buying → max 74 · going concern, 8-K 1.03/3.01/4.02 or extreme illiquidity → quarantined (max 39) ·
a price drop only counts with a valuation signal · yields over 10% earn nothing until investigated ·
13F data is always labelled with its period and filing date and never called a live trade.

Evidence confidence (0–100) is separate: source reliability, completeness, freshness, independent confirmations
(market cap and price vs the Nasdaq list), restatements and reporting delays.

Classes: 90+ exceptional · 80+ strong · 70+ developing · 60+ early watchlist.

Opportunity alerts (Nov 15): score 72+ and confidence 55+. A Value-lens name must also pass the quality overlay
(`engines/quality.py`): ROIC ≥ 12% with earnings yield ≥ 6% or EBIT/EV ≥ 8%, or an F-Score-style check ≥ 7/9 — unless insiders
are buying heavily at the same time (2+ insiders in 30 days with $250k+, or a CEO/CFO/President/Chair buying $250k+).
Model range: bear/base/bull equity values from multiples the company and its peers actually traded at; shown as
unavailable when the inputs aren't there. Never a price target.

## Data sources

| Source | Gives us | Status |
|---|---|---|
| SEC EDGAR | identity (CIK), financial statements (XBRL), 8-K items, Form 4, 13F, 13D/13G | primary · free · needs `SEC_USER_AGENT` secret ("Name email") |
| Yahoo Finance chart API | delayed daily prices, dividends, splits (US + TSX) | supplementary, unofficial |
| Nasdaq.com screener | list of US stocks with price/market cap used to pre-filter and cross-check | supplementary |
| FRED | Fed funds, CPI, core PCE, unemployment, GDP, 2y/10y, curve, HY spreads, oil, gas, copper, USD/CAD | official, keyless |
| Bank of Canada Valet | policy rate, USD/CAD, Canada 2y/10y | official, keyless |
| OpenFIGI | CUSIP → ticker for 13F holdings | free (optional `OPENFIGI_API_KEY`) |
| Google News RSS | headline discovery (not used for scores) | aggregator |
| SEDAR+, SEDI | Canadian filings and insider trades | **blocked**: no API, scraping not allowed. Canadian companies that also file with the SEC are fully covered. TSX-only names get prices only and are capped at 69. |
| Congressional trades | House/Senate disclosures | **blocked** in V1: scanned PDFs / interactive site; needs a PDF pipeline |
| ETF flows, AUM, holdings, fees | | **blocked**: no free official feed; those ETF components score zero and lower confidence |
| Forward estimates / revisions | | **blocked**: no free consensus source; forward P/E shown as n/a |
| AI summaries (LLM) | | **blocked** until an `ANTHROPIC_API_KEY` is added; nothing in scoring depends on it |

## Files in `data/stocks/`

`master.json` security master · `universe.json` all scored stocks · `opportunities.json` rankings, ETFs, rotation ·
`sec/<id>.json` full research page per stock (metrics, every component with reasons, scenarios, insider, 13F, events,
statements with accession numbers, sources) · `macro.json` · `insiders.json` · `institutions.json` · `cusip_map.json` ·
`alerts.json` (dedupe + delivery log) · `candidates.jsonl` (append-only discoveries) · `history/scores-YYYY-MM.jsonl`
(append-only daily scores) · `performance.json` · `backtest.json` · `digests/` · `ticker_history.jsonl` · `health*.json`.

## Security

No API keys in code or the repo: GitHub secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SEC_USER_AGENT`,
optional `OPENFIGI_API_KEY`. Logs never print the Telegram URL. The Telegram bot only posts to the configured chat.
The dashboard is password-protected (`DASHBOARD_PASSWORD` on Vercel). No brokerage or trading code exists.

## V1 checklist

**Working (tested on synthetic data; live data pending the SEC secret):** security master with CIK IDs, share
classes, Canadian detection and verified TSX dual listings · ticker change history · XBRL statements with TTM,
restatement history and point-in-time filtering · ratios incl. CAD reporters · value / growth / dividend / health /
risk / ETF / insider / 13F / macro engines · deterministic versioned scoring with caps and quarantine · separate
confidence · scenarios with “unavailable” fallback · alert dedupe · digest · discovery history and return tracking ·
point-in-time backtest · provider registry and health · dashboard pages.

**Partial:** ETFs (no holdings/fees/flows) · Canada (SEC filers full; TSX-only price-only) · 13F (25 tracked managers,
weekly) · news (headlines only, not scored) · earnings dates (not available free) · sector rotation (price + breadth,
no flows) · backtest (survivorship bias; insider/13F/peer parts not replayed) · watchlist (file `data/stocks/watchlist.json`;
no add/remove buttons yet).

**Blocked:** SEDAR+/SEDI, congressional trades, ETF flows, consensus estimates, LLM summaries, licensed real-time quotes.

**Not built in V1:** Telegram commands for stocks (`/analyze`, `/score`, …) — the dashboard covers these; can be added
to the existing Worker later.
