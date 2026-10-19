# Telegram bot — setup (free, ~15 minutes)

Lets you text your bot `/scan`, `/check 0x…`, `/research`, `/status`, and use the
**/paper** paper-trading buttons. The Worker is also the bot's reliable 15-minute clock.
Telegram → a free Cloudflare Worker → GitHub Actions.

## 1. GitHub token (lets the Worker start runs)
1. Go to **github.com/settings/personal-access-tokens/new** (Fine-grained token).
2. Token name: `hood-scanner telegram`. Expiration: 1 year (set a reminder to renew).
3. **Repository access → Only select repositories → hood-scanner**.
4. **Permissions → Repository permissions → Actions → Read and write**. Leave everything else as is.
5. **Generate token** and copy it (starts with `github_pat_`).

## 2. Cloudflare Worker
1. Sign up free at **dash.cloudflare.com** (no card needed for Workers).
2. **Workers & Pages → Create → Create Worker** (the "Hello World" starter is fine). Name it `hood-scanner-bot` → **Deploy**.
3. **Edit code** → delete everything → paste all of `worker/worker.js` from this repo → **Deploy**.
4. Go back to the Worker → **Settings → Variables and Secrets → Add**:

   | Name | Type | Value |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | Secret | your bot token from BotFather |
   | `ALLOWED_CHAT_ID` | Secret | your chat ID (same as the `TELEGRAM_CHAT_ID` GitHub secret) |
   | `GITHUB_TOKEN` | Secret | the `github_pat_…` token from step 1 |
   | `WEBHOOK_SECRET` | Secret | make one up: 20+ letters/numbers, e.g. `loash_hood_7f3k9q2m8x` (only letters, numbers, `_` and `-`) |
   | `GITHUB_REPO` | Text | `itsloashh/hood-scanner` |

   Click **Deploy** / **Save** after adding them.
5. **Paper wallet storage (KV):** go to **Storage & Databases → KV → Create** (name it `hood-paper`).
   Back in the Worker: **Settings → Bindings → Add → KV namespace**, set the **Variable name** to `PAPER`, pick `hood-paper`, and **Deploy**.
6. **Clock:** go to Worker **Settings → Triggers → Cron Triggers → Add** and add both:
   - `*/5 * * * *` (paper TP/SL + position updates every 5 min; a scan every 15 min)
   - `23 14 * * *` (daily research)

## Phone-friendly alternative to pasting code (recommended)
The repo includes `wrangler.jsonc`, so Cloudflare can build the bot straight from GitHub:
Worker → **Settings → Builds → Connect** → GitHub → **itsloashh/hood-scanner** → branch **main** → Save.
Set **Build watch paths → Include** to `worker/*` and `wrangler.jsonc`, so the bot's 15-minute data commits don't trigger rebuilds.
This also sets the cron triggers, the PAPER storage binding, and GITHUB_REPO automatically. You only add the 4 secrets.

## 3. Connect Telegram
Open this in your browser (your Worker's address is shown on its page):

```
https://hood-scanner-bot.<your-subdomain>.workers.dev/setup?key=<your WEBHOOK_SECRET>
```

You should see **"✅ Telegram is connected."** Then send `/help` to your bot.

## Commands

**💰 Budget assistant** (`/budget` or the 💰 Budget button) — stored only in the Worker's private KV, never in the public repo.
- ➕ Add bill: type `Rent 1200 on the 1st`, `Phone $85.50 15th`… (keeps listening so you can add several; tap Done)
- 💵 I got paid: type the amount (or `/paid 1850`). It sorts the cheque: bills due before your next payday get fully covered first, later bills get their share so they're ready by their due date, then monthly essentials, then the rest splits into 🛍 spending / 🎉 leisure / 📈 investing.
- 🛒 Essentials (monthly: groceries, gas…), ⚖️ split % (40/30/30, 50/30/20…), 📅 pay schedule (weekly / every 2 weeks / twice a month / monthly), 📜 history.
- 9 AM reminders for bills due today and in 3 days, and a note when a bill's due date passes (paid from what was set aside).
Send `/menu` once to get a permanent button bar at the bottom of the chat: 🌍 FX desk · 📅 FX calendar · 📜 Signals · 📋 Paper · 📍 Status · 🚀 Scan now.

- `/fx` — FX desk menu (buttons): 🥇 Gold · 🇨🇦🇯🇵 CAD/JPY (lean, reasons, structure, levels, next releases) · 📅 Calendar (24h / week / high-impact only) · 📰 Headlines (all / per pair) · 📊 Drivers & rates · 🎯 Track record · 🌍 Full brief now. Every FX alert also carries these buttons.
- `/scan` — full scan now (results ~4 min; alerts only if something qualifies)
- `/check 0x…` — full report on one coin, even if it fails your rules. Pasting an address works too.
- `/research` — research job now (10–30 min)
- `/signals` — every coin the bot has called: first call time + market cap, when each watch / buy / ignition / pump signal came, and whether it's hitting the 3x goal. Tap a coin for its full timeline. Also under /paper → 📜 Signals.
- `/status` — what the last scan found (instant)
- `/catalyst 0x… Robinhood app listing` — tag a coin with news for +6 score for 14 days (`/catalyst 0x… remove` to untag, `/catalyst` to list)
- `/paper` — paper trading menu:
  - **🛒 Place trade** — coins the scanner analysed in the last 24h → pick a size (5% / 10% / 25% / 50% / All of your cash), or a limit buy at the pullback entry for pumping coins
  - **🎯 TP / SL** — default stop, take-profits, runner and size for new trades
  - **📂 Positions** — open trades with live price, sell 25/50/100%, move stop (incl. breakeven), change TP1, cancel limit orders
  - **💰 Wallet** — cash, money in positions, money reserved for limit orders, total vs your starting amount (reset to $30 / $100 / $1k / $10k)
  - **📊 P/L** — locked-in vs open profit, win rate, best/worst, last trades
  Every scanner alert also has **📝 Paper buy** / **📋 Paper menu** buttons. Pumping-coin alerts have **Paper limit buy @ entry**.
  Every 5 minutes the Worker marks positions to market, sends a 📈/📉 update each time a trade moves another 10% (change it under 🎯 TP / SL → Updates 5% / 10% / 20% / Off) and runs your TP/SL/trailing stops and limit fills, messaging you on each fill.

Only your chat ID can use it — anyone else is silently ignored. Requests that don't carry
your `WEBHOOK_SECRET` are rejected, so nobody can fake Telegram messages to the Worker.

## Troubleshooting
- **"GitHub rejected the token"** → token expired or pasted wrong → make a new one, update `GITHUB_TOKEN`.
- **"token lacks access"** → token must include the hood-scanner repo with **Actions: Read and write**.
- **Bot doesn't answer at all** → re-open the `/setup?key=…` link; check `ALLOWED_CHAT_ID` is your chat ID.
