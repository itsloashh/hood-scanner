// GeckoTerminal (free, keyless) — pools, token info, daily candles.
import { CONFIG } from '../config.js';
import { getJson } from './http.js';

const base = () => `${CONFIG.geckoBase}/networks/${CONFIG.network}`;
const opts = () => ({ minIntervalMs: CONFIG.geckoMinIntervalMs });
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const addrFromId = (id) => (id ? id.split('_').slice(1).join('_').toLowerCase() : null);

export function parsePools(json) {
  if (!json?.data) return [];
  const tokens = new Map();
  for (const inc of json.included || []) {
    if (inc.type === 'token') {
      tokens.set(inc.id, {
        address: inc.attributes.address?.toLowerCase(),
        symbol: inc.attributes.symbol,
        name: inc.attributes.name,
      });
    }
  }
  return json.data.map((p) => {
    const a = p.attributes || {};
    const baseId = p.relationships?.base_token?.data?.id;
    const quoteId = p.relationships?.quote_token?.data?.id;
    const tx = a.transactions?.h24 || {};
    return {
      poolAddress: a.address?.toLowerCase(),
      name: a.name,
      baseToken: tokens.get(baseId) || { address: addrFromId(baseId), symbol: a.name?.split(' / ')[0], name: null },
      quoteToken: tokens.get(quoteId) || { address: addrFromId(quoteId), symbol: a.name?.split(' / ')[1], name: null },
      priceUsd: num(a.base_token_price_usd),
      marketCap: num(a.market_cap_usd) ?? num(a.fdv_usd),
      marketCapIsFdv: a.market_cap_usd == null,
      liquidityUsd: num(a.reserve_in_usd),
      createdAt: a.pool_created_at || null,
      change: {
        h1: num(a.price_change_percentage?.h1),
        h6: num(a.price_change_percentage?.h6),
        h24: num(a.price_change_percentage?.h24),
      },
      buys24h: num(tx.buys) || 0,
      sells24h: num(tx.sells) || 0,
      buyers24h: num(tx.buyers) || 0,
      sellers24h: num(tx.sellers) || 0,
      volume24h: num(a.volume_usd?.h24) || 0,
      // GeckoTerminal community data (free): votes + "suspicious" reports
      sentimentPos: num(a.sentiment_vote_positive_percentage),
      sentimentNeg: num(a.sentiment_vote_negative_percentage),
      susReports: num(a.community_sus_report) || 0,
    };
  });
}

const Q = 'include=base_token,quote_token&include_gt_community_data=true';

export async function listPools(sort, page) {
  return parsePools(await getJson(`${base()}/pools?page=${page}&sort=${sort}&${Q}`, opts()));
}

export async function trendingPools(page = 1) {
  return parsePools(await getJson(`${base()}/trending_pools?page=${page}&${Q}`, opts()));
}

export async function poolsMulti(addresses) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30).join(',');
    out.push(...parsePools(await getJson(`${base()}/pools/multi/${chunk}?${Q}`, opts())));
  }
  return out;
}

// token address → its most liquid pool address (up to 30 tokens per call)
export async function topPoolsFor(tokenAddresses) {
  const map = {};
  for (let i = 0; i < tokenAddresses.length; i += 30) {
    const chunk = tokenAddresses.slice(i, i + 30).join(',');
    const json = await getJson(`${base()}/tokens/multi/${chunk}?include=top_pools`, opts());
    for (const t of json?.data || []) {
      const pid = t.relationships?.top_pools?.data?.[0]?.id;
      const addr = t.attributes?.address?.toLowerCase();
      if (pid && addr) map[addr] = addrFromId(pid);
    }
  }
  return map;
}

export async function tokenInfo(address) {
  const json = await getJson(`${base()}/tokens/${address}/info`, opts());
  const a = json?.data?.attributes;
  if (!a) return null;
  const dist = a.holders?.distribution_percentage || {};
  return {
    holders: num(a.holders?.count),
    top10PctRaw: num(dist.top_10), // includes LP/contracts/burn — backup only
    twitter: a.twitter_handle || null,
    telegram: a.telegram_handle || null,
    websites: a.websites || [],
    discord: a.discord_url || null,
    gtScore: num(a.gt_score),
    isHoneypot: a.is_honeypot,
    devAddress: a.developer_address?.toLowerCase() || null,
    devPct: num(a.developer_holding_percentage),
    categories: a.categories || [],
  };
}

// Daily candles, oldest → newest: [{t, o, h, l, c, v}]
export async function ohlcvDaily(poolAddress, limit = 60) {
  const json = await getJson(
    `${base()}/pools/${poolAddress}/ohlcv/day?limit=${limit}&currency=usd&token=base`,
    opts()
  );
  const list = json?.data?.attributes?.ohlcv_list || [];
  return list
    .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o: +o, h: +h, l: +l, c: +c, v: +v }))
    .sort((a, b) => a.t - b.t);
}
