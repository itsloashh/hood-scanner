// Blockscout — Robinhood Chain's official explorer.
// With BLOCKSCOUT_API_KEY set (free at dev.blockscout.com) requests go through the
// PRO API, which doesn't block GitHub's servers. Without a key it falls back to the
// public explorer (fine from a home PC, usually blocked from cloud servers).
import { CONFIG } from '../config.js';
import { getJson } from './http.js';

const opts = () => ({ minIntervalMs: CONFIG.blockscoutMinIntervalMs });
export const usage = { calls: 0 };

export const hasKey = () => Boolean(process.env.BLOCKSCOUT_API_KEY);

export function bsUrl(path, params = {}) {
  const key = process.env.BLOCKSCOUT_API_KEY;
  const base = key ? `${CONFIG.blockscoutProBase}/${CONFIG.chainId}/api/v2` : CONFIG.blockscoutBase;
  const q = new URLSearchParams(params);
  if (key) q.set('apikey', key);
  const qs = q.toString();
  return `${base}${path}${qs ? `?${qs}` : ''}`;
}

async function bsGet(path, params) {
  usage.calls += 1;
  return getJson(bsUrl(path, params), opts());
}

export const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

// Discovery: ERC-20 tokens on the chain ordered by holder count. This catches
// established coins whose volume is too quiet for GeckoTerminal's top lists.
export async function listTokensByHolders(maxPages = 4) {
  const out = [];
  let params = { type: 'ERC-20', sort: 'holders_count', order: 'desc' };
  for (let page = 0; page < maxPages && params; page++) {
    const d = await bsGet('/tokens', params);
    for (const t of d?.items || []) {
      out.push({
        address: (t.address_hash || t.address)?.toLowerCase(),
        symbol: t.symbol,
        name: t.name,
        holders: Number(t.holders_count ?? t.holders ?? 0),
      });
    }
    const next = d?.next_page_params;
    params = next ? { type: 'ERC-20', sort: 'holders_count', order: 'desc', ...next } : null;
  }
  return out.filter((t) => t.address);
}

export async function tokenMeta(address) {
  const d = await bsGet(`/tokens/${address}`);
  if (!d) return null;
  return {
    holders: Number(d.holders_count ?? d.holders ?? NaN) || null,
    totalSupply: d.total_supply ? BigInt(d.total_supply) : null,
  };
}

export async function topHolders(address) {
  const d = await bsGet(`/tokens/${address}/holders`);
  return (d?.items || []).map((it) => ({
    address: it.address?.hash?.toLowerCase(),
    isContract: Boolean(it.address?.is_contract),
    value: BigInt(it.value || '0'),
  }));
}

// Block number at a moment in time (Etherscan-style RPC endpoint).
export async function blockAt(ms) {
  const key = process.env.BLOCKSCOUT_API_KEY;
  const ts = Math.floor(ms / 1000);
  const q = `module=block&action=getblocknobytime&timestamp=${ts}&closest=before`;
  const url = key
    ? `${CONFIG.blockscoutProBase}/v2/api?chain_id=${CONFIG.chainId}&${q}&apikey=${key}`
    : `${CONFIG.blockscoutBase.replace('/api/v2', '')}/api?${q}`;
  usage.calls += 1;
  const d = await getJson(url, opts());
  const n = Number(d?.result?.blockNumber ?? d?.result);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Token transfers, newest first, paging back until `sinceMs` (or maxPages).
// With `untilMs`, first jumps straight to that point in history (skipping everything
// newer) so busy coins' older history is reachable. diag.jumped says if the jump worked.
export async function tokenTransfers(address, { sinceMs = 0, untilMs = null, maxPages = 20, diag = {} } = {}) {
  const out = [];
  let params = {};
  diag.jumped = false;
  if (untilMs) {
    try {
      const block = await blockAt(untilMs);
      if (block) {
        const d = await bsGet(`/tokens/${address}/transfers`, { block_number: block, index: 2147483647, items_count: 50 });
        const first = d?.items?.[0]?.timestamp ? Date.parse(d.items[0].timestamp) : null;
        // only trust the jump if it really landed at (or before) the requested time
        if (first && first <= untilMs + 2 * 86_400_000) {
          diag.jumped = true;
          params = { block_number: block, index: 2147483647, items_count: 50 };
        }
      }
    } catch {
      /* fall back to paging from the newest transfer */
    }
  }
  for (let page = 0; page < maxPages && params; page++) {
    const d = await bsGet(`/tokens/${address}/transfers`, params);
    const items = d?.items || [];
    for (const it of items) {
      out.push({
        ts: it.timestamp ? Date.parse(it.timestamp) : null,
        block: Number(it.block_number ?? it.block ?? 0),
        tx: it.transaction_hash || it.tx_hash,
        from: it.from?.hash?.toLowerCase(),
        fromIsContract: Boolean(it.from?.is_contract),
        to: it.to?.hash?.toLowerCase(),
        toIsContract: Boolean(it.to?.is_contract),
        value: it.total?.value ?? '0',
        decimals: Number(it.total?.decimals ?? 18),
      });
    }
    const oldest = items.at(-1)?.timestamp ? Date.parse(items.at(-1).timestamp) : null;
    if (!items.length || (oldest && oldest < sinceMs)) break;
    params = d?.next_page_params || null;
  }
  return out;
}

// Burn activity: transfers of this token INTO the burn addresses since `sinceMs`.
export async function recentBurns(token, sinceMs) {
  let count = 0;
  let units = 0;
  let lastTs = null;
  for (const burnAddr of BURN_ADDRESSES) {
    const d = await bsGet(`/addresses/${burnAddr}/token-transfers`, { type: 'ERC-20', filter: 'to', token });
    for (const it of d?.items || []) {
      if ((it.token?.address_hash || it.token?.address || '').toLowerCase() !== token.toLowerCase()) continue;
      const ts = it.timestamp ? Date.parse(it.timestamp) : 0;
      if (ts < sinceMs) continue;
      if (BURN_ADDRESSES.has(it.from?.hash?.toLowerCase())) continue;
      count += 1;
      const dec = Number(it.total?.decimals ?? 18);
      units += Number(BigInt(it.total?.value ?? '0') / 10n ** BigInt(Math.max(0, dec - 4))) / 1e4;
      lastTs = Math.max(lastTs || 0, ts);
    }
  }
  return { count, units, lastTs };
}

const pctOf = (part, whole) => (whole > 0n ? Number((part * 1_000_000n) / whole) / 10_000 : 0);

// Backup when Blockscout can't give holder lists: GeckoTerminal's top-10 share
// includes the LP pool, so subtract an estimate of the pool's share
// (≈ half the pool's USD reserve, as a share of market cap). Top-1 is unknown.
export function estimateConcentration(info, pool) {
  if (info?.top10PctRaw == null) return null;
  const lpPct = pool.marketCap ? Math.min(60, ((pool.liquidityUsd || 0) / 2 / pool.marketCap) * 100) : 0;
  return {
    top1Pct: null,
    top10Pct: Math.max(0, info.top10PctRaw - lpPct),
    largestContractPct: 0,
    burnedPct: null,
    devPctOnchain: null,
    source: 'estimate',
  };
}

// Concentration across REAL wallets: excludes burn addresses, the trading pool(s)
// and any contract (bonding curves, lockers, LP). Contract holdings are reported
// separately so a big non-pool contract still shows up as a warning.
export function concentration(holders, totalSupply, { poolAddresses = [], devAddress = null } = {}) {
  if (!totalSupply || totalSupply === 0n) return null;
  const pools = new Set(poolAddresses.map((a) => a.toLowerCase()));
  let burned = 0n;
  const wallets = [];
  let largestContract = 0n;
  for (const h of holders) {
    if (BURN_ADDRESSES.has(h.address)) {
      burned += h.value;
      continue;
    }
    if (pools.has(h.address)) continue;
    if (h.isContract) {
      if (h.value > largestContract) largestContract = h.value;
      continue;
    }
    wallets.push(h);
  }
  const circulating = totalSupply - burned;
  wallets.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const top10 = wallets.slice(0, 10).reduce((s, h) => s + h.value, 0n);
  const dev = devAddress ? wallets.find((w) => w.address === devAddress) : null;
  return {
    top1Pct: wallets[0] ? pctOf(wallets[0].value, circulating) : 0,
    top10Pct: pctOf(top10, circulating),
    largestContractPct: pctOf(largestContract, circulating),
    burnedPct: pctOf(burned, totalSupply),
    devPctOnchain: dev ? pctOf(dev.value, circulating) : null,
  };
}
