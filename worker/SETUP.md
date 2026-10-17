# Telegram commands — setup (free, ~10 minutes)

Lets you text your bot `/scan`, `/check 0x…`, `/research` and `/status`.
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

## 3. Connect Telegram
Open this in your browser (your Worker's address is shown on its page):

```
https://hood-scanner-bot.<your-subdomain>.workers.dev/setup?key=<your WEBHOOK_SECRET>
```

You should see **"✅ Telegram is connected."** Then send `/help` to your bot.

## Commands
- `/scan` — full scan now (results ~4 min; alerts only if something qualifies)
- `/check 0x…` — full report on one coin, even if it fails your rules. Pasting an address works too.
- `/research` — research job now (10–30 min)
- `/status` — last scan, paper bankroll, open trades (instant)

Only your chat ID can use it — anyone else is silently ignored. Requests that don't carry
your `WEBHOOK_SECRET` are rejected, so nobody can fake Telegram messages to the Worker.

## Troubleshooting
- **"GitHub rejected the token"** → token expired or pasted wrong → make a new one, update `GITHUB_TOKEN`.
- **"token lacks access"** → token must include the hood-scanner repo with **Actions: Read and write**.
- **Bot doesn't answer at all** → re-open the `/setup?key=…` link; check `ALLOWED_CHAT_ID` is your chat ID.
