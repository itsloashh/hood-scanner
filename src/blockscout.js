// Blockscout — Robinhood Chain's official explorer (free, keyless).
// Used for real holder counts and wallet concentration.
import { CONFIG } from '../config.js';
import { getJson } from './http.js';

const opts = () => ({ minIntervalMs: CONFIG.blockscoutMinIntervalMs });

export const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

// Discovery: ERC-20 tokens on the chain ordered by holder count. This catches
// established coins whose volume is too quiet for GeckoTerminal's top lists.
export async function listTokensByHolders(maxPages = 4) {
  const out = [];
  let params = 'type=ERC-20&sort=holders_count&order=desc';
  for (let page = 0; page < maxPages && params; page++) {
    const d = await getJson(`${CONFIG.blockscoutBase}/tokens?${params}`, opts());
    for (const t of d?.items || []) {
      out.push({
        address: (t.address_hash || t.address)?.toLowerCase(),
        symbol: t.symbol,
        name: t.name,
        holders: Number(t.holders_count ?? t.holders ?? 0),
      });
    }
    const next = d?.next_page_params;
    params = next ? `type=ERC-20&sort=holders_count&order=desc&${new URLSearchParams(next)}` : null;
  }
  return out.filter((t) => t.address);
}

export async function tokenMeta(address) {
  const d = await getJson(`${CONFIG.blockscoutBase}/tokens/${address}`, opts());
  if (!d) return null;
  return {
    holders: Number(d.holders_count ?? d.holders ?? NaN) || null,
    totalSupply: d.total_supply ? BigInt(d.total_supply) : null,
  };
}

export async function topHolders(address) {
  const d = await getJson(`${CONFIG.blockscoutBase}/tokens/${address}/holders`, opts());
  return (d?.items || []).map((it) => ({
    address: it.address?.hash?.toLowerCase(),
    isContract: Boolean(it.address?.is_contract),
    value: BigInt(it.value || '0'),
  }));
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
