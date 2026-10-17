# HOOD SCANNER

A standalone bot that scans Robinhood Chain memecoins every 2 hours, throws out the junk, scores what's left on the "survivor rebound" thesis, and sends the best finds to your phone. Each alert comes with a trade plan and opens a **paper** position, so the $30 strategy gets tested on real prices before any real money goes in.

**Cost: $0.** It runs on GitHub Actions and uses free, keyless data (GeckoTerminal + Blockscout). Alerts go through Telegram or Discord.

---

## Your parameters (all in `config.js`)

| Rule | Setting |
|---|---|
| Age | over **21 days** (3 weeks) |
| Market cap | **$15k – $333k** |
| Liquidity | at least $5k |
| Established community | 250+ holders, 15+ unique buyers in 24h, at least one social linked |
| Not locked up in a majority wallet | top wallet ≤ 8%, top 10 wallets ≤ 35%, dev ≤ 5% (LP pools, launchpad contracts and burn addresses excluded so they don't skew it) |
| Junk filter | honeypot flag, almost no sellers, already up 100%+ in 24h, dead market cap |
| Targets | conservative 3x–10x |
| Bankroll | $30, split into $10 slices, max 3 open |

## How a coin gets scored (0–100)

The thesis: a 3+ week old coin that already crashed, whose community held on, whose price stopped making new lows, and where buyers are coming back.

| Part | Points | What it rewards |
|---|---|---|
| Community | 25 | holder count, unique buyers, socials |
| Conviction | 10 | holders flat or rising while price fell |
| Distribution | 15 | supply spread across real wallets |
| Structure | 25 | 65–92% off its high, tight 7-day base, lows holding |
| Awakening | 15 | volume above its 7-day average, more buyers than sellers, not already ripping |
| Liquidity | 5 | pool depth vs market cap |
| Narrative | 5 | its narrative leader (cat, dog, hood, AI…) is moving while it's still basing; stock-paired coins |

Alerts fire at **65+**. When chain-wide volume is falling the bar rises to 75; when it's surging it drops to 60. The same coin won't re-alert for 72 hours unless its score jumps 10+.

## The trade plan (paper)

- **Entry:** price at alert (3% slippage assumed each way)
- **Stop:** −50%
- **3x:** sell half — principal back plus profit
- **5x:** sell another quarter
- **Runner:** close at 10x, or if it falls 40% from its peak after the 3x hit
- **Time stop:** 30 days
- Rugs (liquidity pulled) and vanished pools count as near-total losses

You get a phone message on every alert, every paper sell, and a daily summary at 9 AM Toronto time with the bankroll, open positions and win rate.

---

## Setup (about 10 minutes, free)

### 1. Make the Telegram bot
1. In Telegram, message **@BotFather** → send `/newbot` → pick a name. Copy the **token** it gives you.
2. Send your new bot any message (like "hi").
3. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser. Find `"chat":{"id":` — that number is your **chat ID**.

(Prefer Discord? Create a webhook in a channel's settings and use that URL instead.)

### 2. Put the code on GitHub
1. Create a new **private** repo called `hood-scanner`.
2. Upload everything in this folder (keep the `.github/workflows` folder — that's the schedule).

### 3. Add your secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- (or `DISCORD_WEBHOOK_URL`)

### 4. Turn it on
Repo → **Actions** tab → enable workflows → open **hood-scanner** → **Run workflow**. After that it runs on its own every 2 hours.

**Free-tier math:** private repos get 2,000 Action minutes a month. Each run takes about 3–4 minutes, so 12 runs a day uses roughly 1,100–1,500. Don't go faster than every 2 hours on a private repo. A public repo has no limit and can run every 30 minutes, but your data and settings would be public.

---

## What it saves (in `data/`)

- `snapshots/YYYY-MM.csv` — every coin under $1M market cap, every run: price, market cap, liquidity, holders, concentration, drawdown, score, and why it passed or failed. **This is the research dataset.** Holder history can't be rebuilt later, so it gets more valuable every week it runs.
- `trades.csv` — every closed paper trade.
- `state.json` — open paper positions, bankroll, alert history.

## Tuning

Change numbers in `config.js` and push. The next run uses them. After a few weeks, compare the `snapshots` rows that were alerted against what those coins did afterward, then adjust.

## Run it locally (optional)

```
npm test        # offline tests with fake market data
npm run scan:dry  # live scan, prints alerts instead of sending
```

---

## Known limits — read these

- **Age** comes from the pool's creation date and its first daily candle. Time a token spent on a bonding curve before graduating isn't counted, so some coins are older than shown. This errs on the safe side.
- **Market cap** for unverified tokens may be fully diluted value (flagged "FDV" in alerts).
- **Honeypot check** is a proxy: GeckoTerminal's flag plus requiring real sellers in the last 24h. It is not a simulated sell. Always test-sell a tiny amount before sizing in.
- **Coverage:** each run scans the top ~400 pools by volume and transactions. Coins with zero activity aren't scanned — by design.
- **If holder data is missing, the coin is rejected.** Missing data never counts as a pass.
- This is a research tool, not financial advice. Most memecoins go to zero. Run paper mode for at least 2 weeks and ~20 alerts before putting real money behind it.
