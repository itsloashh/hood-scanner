# Hood Desk — private dashboard

Next.js 16 app that reads the scanner's committed data (`data/*.json`) from this repo and shows calls, outcomes, analysis and scanner health.

- Hosted on Vercel, project root directory `dashboard`. Builds only when files in `dashboard/` change.
- Login: env `DASHBOARD_PASSWORD` (optional `AUTH_SECRET`; changing either signs everyone out).
- Data refreshes every ~2 minutes; coin price charts come from GeckoTerminal (cached 15 min).
