// UTILITY vs MEME — tags coins that look like they do something (launchpad, DEX/DeFi, AI agents,
// RWA/index, infrastructure), so the scorecard can measure them separately from pure memes.
// Evidence, not promises: a real category, docs, a product description, an ongoing buyback.
const CATEGORY = /defi|dex|launchpad|lending|yield|derivative|perp|ai agent|artificial intelligence|infrastructure|oracle|bridge|real world|rwa|index|gaming|nft marketplace|staking|dao|exchange/i;
const WORDS = /\b(protocol|launchpad|swap|dex|perps?|lending|vault|staking|stake|yield|revenue|fees?|buyback|agent|agents|ai|index|rwa|tokeni[sz]ed|oracle|bridge|marketplace|platform|infrastructure|sdk|api|dao|governance)\b/i;
const MEME = /\bmeme(coin)?\b|community[- ]driven|no utility|just for fun|for the culture/i;
const DOCS = /docs\.|gitbook|whitepaper|\/docs\b|github\.com/i;

export function classify({ info, pool, burns }) {
  const why = [];
  const cats = (info?.categories || []).join(', ');
  if (CATEGORY.test(cats)) why.push(`listed as ${cats}`);
  const desc = info?.description || '';
  if (WORDS.test(desc) && !MEME.test(desc)) why.push('describes a product');
  if ((info?.websites || []).some((w) => DOCS.test(w))) why.push('has docs');
  if ((burns?.recent?.count || 0) >= 3) why.push('ongoing buyback/burn');
  if (/\b(finance|protocol|swap|labs|index|agent)\b/i.test(`${pool?.baseToken?.name || ''}`)) why.push('product name');
  const utility = why.length >= 2 && !MEME.test(desc);
  return { kind: utility ? 'utility' : 'meme', why };
}
