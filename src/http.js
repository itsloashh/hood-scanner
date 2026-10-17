// Polite fetch: per-host rate limiting + retries on 429/5xx.
// Errors are recorded per host so each run can save a health report to state.json.
const lastCall = new Map();
export const httpErrors = {}; // host → { count, last }
// Circuit breaker: after 3 failures in a row (timeouts / 5xx) a host is skipped for the rest of the run,
// so one slow API can't eat the whole 12-minute GitHub run.
const strikes = new Map();
const BREAKER = 3;
const TIMEOUT_MS = 20_000;
export function resetBreakers() {
  strikes.clear();
  pace.clear();
  for (const k of Object.keys(httpStats)) delete httpStats[k];
}
// Per-host timing for the run's health report: where the minutes go
export const httpStats = {}; // host → { calls, ms, waitMs }
const stat = (host) => (httpStats[host] ||= { calls: 0, ms: 0, waitMs: 0, backoffMs: 0, r429: 0 });
const backoff = async (host, ms) => {
  stat(host).backoffMs += ms;
  await sleep(ms);
};
// Adaptive pacing: each 429 slows that host by 50% for the rest of the run (up to 10s/call);
// every success speeds it back up a little. Cheaper than eating 5–15s backoffs over and over.
const pace = new Map();
const MAX_INTERVAL = 10_000;
const strike = (host) => strikes.set(host, (strikes.get(host) || 0) + 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The repo is public, so its run logs are too — never let an API key reach them.
export const redact = (s) => String(s).replace(/(apikey|api_key|key)=[^&\s]+/gi, '$1=***');

function recordError(host, msg) {
  const e = (httpErrors[host] ||= { count: 0, last: null });
  e.count += 1;
  e.last = msg;
}

export async function getJson(url, { minIntervalMs = 0, retries = 3 } = {}) {
  const host = new URL(url).host;
  if ((strikes.get(host) || 0) >= BREAKER) throw new Error(`${host} skipped for the rest of this run (kept failing)`);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const interval = Math.max(minIntervalMs, pace.get(host) || 0);
    const wait = (lastCall.get(host) || 0) + interval - Date.now();
    if (wait > 0) {
      stat(host).waitMs += wait;
      await sleep(wait);
    }
    lastCall.set(host, Date.now());
    const t0 = Date.now();
    stat(host).calls += 1;

    let res;
    try {
      res = await globalThis.fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'hood-scanner/2.1 (+github.com/itsloashh/hood-scanner)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      stat(host).ms += Date.now() - t0;
      strike(host);
      if (attempt === retries || (strikes.get(host) || 0) >= BREAKER) {
        recordError(host, redact(`network: ${err.message}`));
        throw new Error(redact(`network error for ${url}: ${err.message}`));
      }
      await backoff(host, 2000 * (attempt + 1));
      continue;
    }
    stat(host).ms += Date.now() - t0;
    if (res.status === 404) return null;
    if (res.status >= 500) strike(host);
    if (res.status === 429) {
      stat(host).r429 += 1;
      pace.set(host, Math.min(MAX_INTERVAL, Math.max(interval * 1.5, 3000)));
    }
    if (res.status === 429 || res.status >= 500) {
      // gateway timeouts (524/504) already cost us the wait — retry once at most
      const maxTries = res.status === 524 || res.status === 504 ? Math.min(1, retries) : retries;
      if (attempt >= maxTries || (strikes.get(host) || 0) >= BREAKER) {
        recordError(host, `HTTP ${res.status}`);
        throw new Error(redact(`HTTP ${res.status} for ${url}`));
      }
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      await backoff(host, retryAfter > 0 && retryAfter < 60 ? retryAfter * 1000 : res.status === 429 ? Math.max(interval, 3000) * (attempt + 1) : Math.max(minIntervalMs, 5000) * (attempt + 1));
      continue;
    }
    if (res.ok) {
      strikes.set(host, 0);
      if (pace.get(host)) pace.set(host, Math.max(minIntervalMs, pace.get(host) * 0.97));
    }
    if (!res.ok) {
      recordError(host, `HTTP ${res.status}`);
      throw new Error(redact(`HTTP ${res.status} for ${url}`));
    }
    try {
      return await res.json();
    } catch (err) {
      recordError(host, `bad JSON: ${err.message}`);
      throw err;
    }
  }
  return null;
}
