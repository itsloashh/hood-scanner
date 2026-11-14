import { Shell } from '@/components/Shell';
import { loadAll } from '@/lib/data';
import { ago } from '@/lib/format';

export default async function DeskLayout({ children }: { children: React.ReactNode }) {
  const { prices } = await loadAll();
  const at = prices.at ? Date.parse(prices.at) : null;
  return <Shell updated={at ? ago(at) : 'unavailable'}>{children}</Shell>;
}
