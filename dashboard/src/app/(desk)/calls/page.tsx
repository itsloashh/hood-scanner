import { loadAll } from '@/lib/data';
import { buildCalls } from '@/lib/calls';
import { CallsTable } from '@/components/CallsTable';
import { PageHeader } from '@/components/ui';

export const revalidate = 120;
export const metadata = { title: 'Calls · Hood Desk' };

export default async function CallsPage({ searchParams }: { searchParams: Promise<{ outcome?: string; lane?: string }> }) {
  const [{ state, prices, prefs }, sp] = await Promise.all([loadAll(), searchParams]);
  const calls = buildCalls(state, prices, prefs);
  const outcome = ['2x', 'win', 'stopped', 'open', 'halved'].includes(sp.outcome ?? '') ? (sp.outcome as '2x') : undefined;
  return (
    <>
      <PageHeader eyebrow="Every coin the bot alerted on" title="Calls" />
      <CallsTable calls={calls} initial={{ outcome, lane: sp.lane }} />
      <p className="mt-4 text-xs text-faint">
        Peak and Now are measured against the price at the first alert. A 3× win means it reached 3× before falling 50%, within 30 days.
      </p>
    </>
  );
}
