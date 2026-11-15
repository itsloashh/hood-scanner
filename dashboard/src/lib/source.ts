// Where the bots' data lives. We read the NEWEST commit directly (raw files at that commit's SHA are
// immutable, so no stale CDN copy), and look the SHA up with git's own ref advertisement — no API rate limit.
const REPO = process.env.SCANNER_REPO || 'itsloashh/hood-scanner';
const BRANCH = process.env.SCANNER_BRANCH || 'main';

export async function latestSha(): Promise<string> {
  try {
    const res = await fetch(`https://github.com/${REPO}.git/info/refs?service=git-upload-pack`, {
      headers: { 'User-Agent': 'git/2.45.0' },
      next: { revalidate: 15, tags: ['sha'] },
    });
    const m = (await res.text()).match(new RegExp(`([0-9a-f]{40}) refs/heads/${BRANCH}`));
    if (m) return m[1];
  } catch {}
  return BRANCH;
}

// Files over Next's 2 MB data-cache limit are fetched straight from GitHub's CDN each time
const BIG = new Set(['data/stocks/universe.json']);

export async function rawJson<T>(path: string, fallback: T): Promise<T> {
  if (process.env.STOCKS_LOCAL_DIR && path.startsWith('data/stocks/')) {
    try {
      const fs = await import('node:fs/promises');
      return JSON.parse(await fs.readFile(`${process.env.STOCKS_LOCAL_DIR}/${decodeURIComponent(path.slice('data/stocks/'.length))}`, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }
  const sha = await latestSha();
  try {
    const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${path}`;
    // a SHA URL never changes, so it can be cached for a day; the branch fallback only briefly
    const res = BIG.has(path) ? await fetch(url, { cache: 'no-store' }) : await fetch(url, { next: { revalidate: sha === BRANCH ? 60 : 86400 } });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export async function dataAge(): Promise<{ sha: string }> {
  return { sha: await latestSha() };
}
