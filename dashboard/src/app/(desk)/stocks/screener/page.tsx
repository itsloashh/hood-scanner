import { loadUniverse } from '@/lib/stocks';
import { StockScreener } from '@/components/StockScreener';
import { NotReady } from '@/components/stock-ui';

export const revalidate = 300;
export const metadata = { title: 'Screener · Hood Desk' };

export default async function ScreenerPage() {
  const uni = await loadUniverse();
  if (!uni.rows.length) return <NotReady />;
  return (
    <>
      <StockScreener rows={uni.rows} />
      <p className="mt-4 text-xs text-faint">Score = thesis quality. Evidence = how complete and verified the data is. Base case = model equity value vs today’s market cap (where defensible).</p>
    </>
  );
}
