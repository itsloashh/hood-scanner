# HOOD SCANNER

A standalone bot that scans Robinhood Chain memecoins every 15 minutes, around the clock, throws out the junk, scores what's left on the "survivor rebound" thesis, and sends the best finds to your phone. Each alert comes with a trade plan and opens a **paper** position, so the strategy gets tested on real prices before any real money goes in.

**Cost: $0.** It runs on GitHub Actions (unlimited on a public repo) and uses free, keyless data (GeckoTerminal + Blockscout + Telegram). Alerts go out any hour, the moment a coin qualifies.

---

## Your parameters (all in `config.js`)

| Rule | Setting |
|---|---|
| Age | over **21 days** (3 weeks) |
| Market cap | two lanes: **🧪 Micro $5k – $333k** (survivor bounces, small size only) and **🏛 Quality $333k – $25M** (established coins setting up a second leg) |
| Quality lane extras | 5,000+ holders, $10+ of market cap per holder (no padded counts), $100k+ liquidity, 50–90% off its high |
| Liquidity | at least $3k (micro) / $100k (quality) |
| Copycats | a coin using the ticker of an established coin (5k+ holders) from a different contract is rejected |
| Established community | 150+ holders, 8+ unique buyers in 24h, at least one social linked, ≤ 2 GeckoTerminal "suspicious" reports |
| Not locked up in a majority wallet | top wallet ≤ 8%, top 10 wallets ≤ 40%, dev ≤ 5% (LP pools, launchpad contracts and burn addresses excluded so they don't skew it) |
| Junk filter | honeypot flag, almost no sellers, already up 100%+ in 24h, dead market cap |
| Targets | conservative 3x–10x |
| Paper wallet | any starting amount ($30 / $100 / $1k / $10k); trades sized as % of cash |

## How a coin gets scored (0–100)

The thesis: a 3+ week old coin that already crashed, whose community held on, whose price stopped making new lows, and where buyers are coming back.

**What the case study taught it (CASHCAT, PONS, FRONG, DIH, 🪶):** every one had a second leg 26–41 days after launch, starting 73–99% off its high, out of a **quiet base** (sideways price while volume dried up to 0.37–0.79× of normal), then a sudden **volume ignition** (8–24×) and 3x within 1–6 days. The quality ones had a reason to exist (chain identity, a buyback-and-burn) and a **catalyst** that brought in outside buyers (Robinhood app listing, Binance Wallet). So the scanner adds, on top of the 100 points:
- **Quiet base** up to +8: crashed, sideways, volume drying up.
- **Absorption base** up to +8 (FLORK's 19× setup): crashed, price flat for a week while volume *rises* — weak sellers being soaked up by steady buyers. Not when price is dumping on that volume or sellers swamp buyers.
- **Catalysts** up to +8: your `/catalyst` tag (+6 for 14 days), an ongoing buyback (3+ burns a week, +2), chain identity (Robinhood-themed or launchpad token, +2).
- **🔥 IGNITION alert**: coins in a quiet base get their hourly candles checked every run. Last 3 hours at 5×+ normal volume, price rising and no more than 40% above the base = immediate alert.

| Part | Points | What it rewards |
|---|---|---|
| Community | 25 | holders, unique buyers, socials, Telegram group size, GeckoTerminal trust score + votes; penalties for a recycled X handle or suspicious reports |
| Conviction | 10 | holders flat or rising while price fell |
| Distribution | 15 | supply spread across real wallets |
| Structure | 25 | 65–92% off its high, tight 7-day base, lows holding |
| Awakening | 15 | volume above its 7-day average, more buyers than sellers, not already ripping |
| Liquidity | 5 | pool depth vs market cap |
| Narrative | 5 | its narrative leader (cat, dog, hood, AI…) is moving while it's still basing; stock-paired coins |

Two alert tiers:
- **🟢 BUY ZONE (65+)** — full trade plan, opens a paper position.
- **👀 WATCH (50–64)** — heads-up that a coin passed every junk check and is close. No paper position.

When chain-wide volume is falling both bars rise 10 points; when it's surging they drop 5. A coin won't re-alert for 72h (buy) / 24h (watch) unless its score jumps 10+.

## Community & X signals (free)

X's API has no free tier any more (reading posts costs $0.005 each), so the bot measures community without it:
- **Telegram group size** of the coin's linked group, via your own bot (free).
- **Recycled X handle** — if the same @handle is linked to more than one token, that's flagged as a likely copycat or recycled scam.
- **GeckoTerminal** community sentiment votes, "suspicious" reports and trust score.
- Every alert links the coin's X account so you can eyeball it yourself in one tap.

## The trade plan (paper)

- **Entry:** price at alert (3% slippage assumed each way)
- **Stop:** −50%
- **3x:** sell half — principal back plus profit
- **5x:** sell another quarter
- **Runner:** close at 10x, or if it falls 40% from its peak after the 3x hit
- **Time stop:** 30 days
- Rugs (liquidity pulled) and vanished pools count as near-total losses

You get a phone message on every alert (any hour), every paper sell, and a summary every 4 hours with the bankroll, win rate, and a **funnel** showing how many coins passed each stage and the top reasons coins got cut — that's how to tell if a filter is too tight.

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

**Keep the repo public.** Public repos get unlimited free Action minutes, which is what allows a scan every 15 minutes. Your Telegram secrets stay hidden; the code, settings and dataset are visible. (Private repos are capped at 2,000 min/month — you'd have to slow the schedule to every ~90 min.) GitHub may delay scheduled runs by a few minutes when it's busy.

---

## What it saves (in `data/`)

- `snapshots/v2-YYYY-MM.csv` — every coin under $1M market cap, hourly: price, market cap, liquidity, holders, concentration, drawdown, score, and why it passed or failed. **This is the research dataset.** Holder history can't be rebuilt later, so it gets more valuable every week it runs.
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

## 🔥 Burns
Each candidate's burned supply (% held by 0x…dead / 0x0) and its burns in the last 7 days are checked through Blockscout (cached 6h). The bonus is up to **+5**: +2 for 20%+ burned (+3 for 50%+), and +2 for burns in the last week. Alerts show a 🔥 BURNS section.

## 🧠 Wallet intelligence (v3)

**Live tracker (free, no key).** Each scan pulls the last 24h of trades for coins that pass the junk filter and records which wallets bought, when, and at what price. Later scans check what happened next: a buy is a **win** if the coin hit 3x within 30 days, and a **loss** if it fell 60% first or time ran out. Wallets with 2+ wins and a 40%+ hit rate become **smart wallets**. Wallets buying 15+ different coins a day are marked as bots and never count.

Every alert now has a **Who's buying** section: how many different wallets bought or sold, net dollars in or out, typical buy size, big buys, repeat buyers, and any smart wallets. Each smart wallet buying adds **+4** to the score (max +10). If 30%+ of buys were bundled (several wallets in the same block, usually bots), the coin loses 5 points.

**Daily research (`research.yml`, every day ~10:23 AM Toronto + on demand).** This reverse-engineers past runners:
1. It finds every time a coin matched our rules (21+ days old, $10k–$333k, 50%+ off its high, tight base with lows holding).
2. It labels each one: did it go 3x within 30 days?
3. It compares winners and duds on volume, base tightness, drawdown, age and market cap. **The hit rate is the number any signal has to beat.**
4. It pulls the wallets that bought in the week *before* each setup, removes bundles and bots, and finds wallets that bought early into 2+ winners while mostly avoiding duds. Those wallets seed the live tracker.

**Only real 3–10x runs count as wins.** Runs past 10x are listed as moonshots but not learned from, because outliers mislead. Setups with fewer than 15 real buyers the week before, or with wash trading, are thrown out as fake or thin.

**Why it pumped.** For every real winner, the report lists what the on-chain data shows. *Before* the run: volume already rising, buyers up 50%+ week-over-week, token burns, smart wallets buying, 20%+ of supply burned, stock pairing, and theme. *During* the run: volume explosion and burns. It then ranks each signal by how much more often it shows up in winners than in duds (`data/research/catalysts.json`). A signal that keeps showing up before winners is a candidate for a new scanner parameter. If a winner has no on-chain reason, the cause was likely off-chain (X, a listing, news), and the report links an X search filtered to verified accounts.

**Accuracy tracking.** Every alert (buy, watch, pump, ignition) is followed for 30 days from its alert price: ✅ reached 3x, ❌ fell 50% first, or ⏹ expired. The scorecard shows in the 4-hour summary and in /status, split by tier and lane — this is how parameters get tuned, by what actually ran. Alert prices are also double-checked against DexPaprika; a >10% disagreement is flagged. Coins only reach the buy zone when their biggest wallet was actually checked (top-wallet lists come from a separate `holders` job every 30 min, because Blockscout is slow).

Results: `data/research/report.md`, `setups.csv` and `smart-wallets.json`, plus a Telegram summary. Run it any time: **Actions → research → Run workflow**.

### Free Blockscout key (needed for holder lists + wallet research)
Blockscout blocks anonymous requests from GitHub's servers. Its free API key fixes that (no card, about 100k credits a day; the bot caches to stay well under):
1. Go to **dev.blockscout.com**, sign up, then **Keys → Create API Key**.
2. In the repo: **Settings → Secrets and variables → Actions → New repository secret**, name it `BLOCKSCOUT_API_KEY`, and paste the key.

The key is never printed. Error messages redact it, because this repo's logs are public.
Without the key, the scanner still runs: holder spread is estimated from GeckoTerminal, and wallet research is skipped.

## Health report
After every scan, `data/state.json → lastRun` records coins scanned, the funnel, top cut reasons, which holder data source worked, API errors per site, Blockscout usage, and wallet-tracker counts.

## 📝 Paper trading (Telegram buttons)
Paper trades are placed by you, not automatically (`paper.auto: false`). Send **/paper** for the menu: **Place trade · TP/SL · Positions · Wallet · P/L**. You can also tap **📝 Paper buy** on any alert. The wallet starts at $30 (reset it to $100, $1k or $10k under Wallet) and lives in the Telegram Worker's KV storage. Every 15 minutes the Worker checks prices and runs your stop-losses, take-profits, trailing stops and limit-order fills. Setup: `worker/SETUP.md` steps 5–6.

## 🚀 Coins already pumping
A coin up 50%+ in 24h isn't chased. It's judged on its size *before* the pump (still $10k–$333k), and must pass every other rule (age, community, wallet spread, no wash trading). Then you get a **PUMPING** alert covering:
- **Pullback odds** from every past +50% day on Robinhood Chain (`data/research/pullbacks.json`, rebuilt daily): how often a pump that size pulled back 30%+, how much of the move it typically gave back, how soon it bottomed, and how often it made a new high anyway. Until there are 5+ examples for a pump size, it uses the textbook 38–62% retrace and says so.
- **Entry plan:** the zone, the best limit price (the typical pullback), a stop just under where the pump started, and 3x/10x targets from that entry.
- A **Paper limit buy** button that places the order, which fills only if the price actually pulls back.

## 🎯 Target: 3–10x
Every alert shows what 3x and 10x would mean in market cap. Research only learns from runs that peaked between 3x and 10x.

## 📱 Telegram commands
Text your bot `/scan`, `/check 0x…` (or just paste an address), `/research`, `/status`, or `/catalyst 0x… what happened` (tag news like a Robinhood listing; `/catalyst 0x… remove` to untag, `/catalyst` to list).
Free Cloudflare Worker relay — setup in **[worker/SETUP.md](worker/SETUP.md)**.
Without it you can still run anything from **Actions → (workflow) → Run workflow**, including a single-coin check: open **hood-scanner → Run workflow** and paste an address in the box.

## Starting runs without the Run button
Editing `triggers/scan.txt` or `triggers/research.txt` (any change, committed to main) starts that job. That's how Claude can start runs remotely. You can also do it from the GitHub app: open the file, tap ✏️, change the date, and commit.
