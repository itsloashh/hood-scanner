// Polite fetch: per-host rate limiting + retries on 429/5xx.
const lastCall = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, { minIntervalMs = 0, retries = 3 } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (lastCall.get(host) || 0) + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());

    let res;
    try {
      res = await globalThis.fetch(url, { headers: { accept: 'application/json' } });
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      if (attempt === retries) throw new Error(`HTTP ${res.status} for ${url}`);
      await sleep(Math.max(minIntervalMs, 5000) * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  return null;
}
