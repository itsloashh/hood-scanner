import { PageHeader, Section } from '@/components/ui';

export const metadata = { title: 'Stocks · Hood Desk' };

export default function StocksPage() {
  return (
    <>
      <PageHeader eyebrow="Coming next" title="Stock scanner" />
      <Section title="Not set up yet" hint="This slot is ready for the stock ticker scanner once we define what it looks for.">
        <div className="grid gap-3 text-sm text-dim sm:grid-cols-3">
          {[
            ['Universe', 'Which exchanges, price range and market caps to scan.'],
            ['Setups', 'What “potential upside” means: the metrics and thresholds.'],
            ['Alerts', 'When it pings Telegram, and how calls are scored here.'],
          ].map(([t, d]) => (
            <div key={t} className="rounded-xl border border-dashed border-line-2 p-4">
              <div className="font-medium text-text">{t}</div>
              <p className="mt-1">{d}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-faint">Stock calls will show up in the same Calls table and Analysis charts, with a market filter.</p>
      </Section>
    </>
  );
}
