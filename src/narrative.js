// Narrative clusters + rotation. In runs, money tends to flow from a narrative's
// leader down to smaller coins in the same narrative. We tag every coin and check
// whether its cluster leader is moving while it is still basing.

const CLUSTERS = [
  ['cat', /cat|kitty|meow|nyan|purr|kitten/i],
  ['dog', /dog|inu|doge|shib|pup|woof/i],
  ['frog', /pepe|frog|ribbit|kek/i],
  ['hood', /hood|robin|vlad|tenev|stonk|tendies|\bwsb\b|\bape\b|diamond.?hand|yolo|\bgme\b|\bamc\b/i],
  ['ai', /\bai\b|gpt|agent|bot|neural/i],
];

const BASE_QUOTES = new Set(['WETH', 'ETH', 'USDC', 'USDT', 'USDG', 'DAI']);

export function tagNarratives(pool) {
  const text = `${pool.baseToken.symbol || ''} ${pool.baseToken.name || ''}`;
  const tags = CLUSTERS.filter(([, re]) => re.test(text)).map(([name]) => name);
  const quote = (pool.quoteToken.symbol || '').toUpperCase();
  const stockPaired = quote !== '' && !BASE_QUOTES.has(quote);
  if (stockPaired) tags.push('stock-paired');
  return { tags, stockPaired };
}

// Leader of each cluster = the largest market cap coin with that tag in this scan.
export function clusterLeaders(pools) {
  const leaders = new Map();
  for (const p of pools) {
    for (const tag of tagNarratives(p).tags) {
      const cur = leaders.get(tag);
      if (!cur || (p.marketCap ?? 0) > (cur.marketCap ?? 0)) leaders.set(tag, p);
    }
  }
  return leaders;
}

// Rotation: leader up ≥20% in 24h while this coin is still flat-ish.
export function rotationSignal(pool, leaders) {
  const { tags } = tagNarratives(pool);
  for (const tag of tags) {
    const leader = leaders.get(tag);
    if (!leader || leader.baseToken.address === pool.baseToken.address) continue;
    const lch = leader.change.h24 ?? 0;
    const ch = pool.change.h24 ?? 0;
    if (lch >= 20 && ch > -10 && ch < 15) {
      return { active: true, tag, leader: leader.baseToken.symbol, leaderChange: lch };
    }
  }
  return { active: false };
}
