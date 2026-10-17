// Polite fetch: per-host rate limiting + retries on 429/5xx.
// Errors are recorded per host so each run can save a health report to state.json.
const lastCall = new Map();
export const httpErrors = {}; // host → { count, last }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function recordError(host, msg) {
  const e = (httpErrors[host] ||= { count: 0, last: null });
  e.count += 1;
  e.last = msg;
}

export async function getJson(url, { minIntervalMs = 0, retries = 3 } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (lastCall.get(host) || 0) + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());

    let res;
    try {
      res = await globalThis.fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'hood-scanner/2.1 (+github.com/itsloashh/hood-scanner)' },
      });
    } catch (err) {
      if (attempt === retries) {
        recordError(host, `network: ${err.message}`);
        throw err;
      }
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      if (attempt === retries) {
        recordError(host, `HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      await sleep(Math.max(minIntervalMs, 5000) * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      recordError(host, `HTTP ${res.status}`);
      throw new Error(`HTTP ${res.status} for ${url}`);
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
