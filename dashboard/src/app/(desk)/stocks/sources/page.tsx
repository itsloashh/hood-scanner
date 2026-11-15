import { loadHealth } from '@/lib/stocks';
import { Section, Empty } from '@/components/ui';
import { Tag } from '@/components/stock-ui';
import { ago } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Data sources · Hood Desk' };

const TONE: Record<string, 'up' | 'warn' | 'down' | 'dim'> = { ok: 'up', degraded: 'warn', down: 'down', blocked: 'down' };

export default async function SourcesPage() {
  const h = await loadHealth();
  if (!h) return <Empty>No research run has finished yet.</Empty>;
  return (
    <>
      <Section title="Last research run" hint={`${ago(Date.parse(h.updated))} · ${h.minutes} min${h.scored ? ` · ${h.scored.toLocaleString()} stocks scored` : ''}`}>
        <div className="flex flex-wrap gap-2 text-xs">
          {Object.entries(h.stages).map(([k, v]) => (
            <span key={k} className={`rounded-md px-2 py-1 ${v.ok ? 'bg-panel-2 text-dim' : 'bg-down/10 text-down'}`} title={v.error}>
              {k} {v.ok ? '✓' : '✕'} <span className="num text-faint">{v.sec}s</span>
            </span>
          ))}
        </div>
        {h.error && <p className="mt-3 text-sm text-down">{h.error}</p>}
      </Section>
      <div className="mt-4 grid gap-3 @3xl:grid-cols-2">
        {Object.entries(h.providers).map(([k, p]) => (
          <div key={k} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="font-medium">{p.name}</div>
              <Tag tone={TONE[p.status] ?? 'dim'}>{p.status}</Tag>
            </div>
            <div className="mt-1 text-xs text-faint">{p.kind}{p.cost ? ` · ${p.cost}` : ''}{p.key ? ` · key: ${p.key}` : ''}</div>
            {p.why && <p className="mt-2 text-sm text-dim">{p.why}</p>}
            {p.coverage && <p className="mt-2 text-xs text-dim">Coverage: {p.coverage}</p>}
            {p.freshness && <p className="text-xs text-dim">Freshness: {p.freshness}</p>}
            {p.licensing && <p className="text-xs text-faint">Terms: {p.licensing}</p>}
            {p.calls != null && <p className="num mt-1 text-xs text-faint">{p.calls} calls · {p.errors} errors{p.last_error ? ` · ${p.last_error}` : ''}</p>}
          </div>
        ))}
      </div>
    </>
  );
}
