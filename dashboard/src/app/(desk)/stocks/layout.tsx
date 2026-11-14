import { StockTabs } from '@/components/StockTabs';

export default function StocksLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <StockTabs />
      {children}
    </>
  );
}
