// Blockscout — Robinhood Chain's official explorer (free, keyless).
// Used for real holder counts and wallet concentration.
import { CONFIG } from '../config.js';
import { getJson } from './http.js';

const opts = () => ({ minIntervalMs: CONFIG.blockscoutMinIntervalMs });

export const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

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
