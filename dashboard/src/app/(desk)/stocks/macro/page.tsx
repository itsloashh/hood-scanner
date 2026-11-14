import { loadMacro, loadOpps } from '@/lib/stocks';
import { Pill, Section } from '@/components/ui';
import { NotReady, Tag, pctS } from '@/components/stock-ui';
import { ago, date } from '@/lib/format';

export const revalidate = 600;
export const metadata = { title: 'Economy · Hood Desk' };

export default async function MacroPage() {
  const [macro, opps] = await Promise.all([loadMacro(), loadOpps()]);
  if (!macro) return <NotReady />;
  const tilt = Object.entries(macro.sector_tilt).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Pill>Updated {ago(Date.parse(macro.updated))}</Pill>
        {macro.usdcad && <Pill>USD/CAD {macro.usdcad.toFixed(4)}</Pill>}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Economic readings" hint="Direction over the last month (quarter for GDP). Reading = what that direction usually means for stocks." className="lg:col-span-2">
          <div className="scroll-x">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs text-faint">
                <tr className="border-b border-line">
                  <th className="py-2 font-medium">Series</th>
                  <th className="py-2 text-right font-medium">Latest</th>
                  <th className="py-2 text-right font-medium">Change</th>
                  <th className="py-2 pl-3 font-medium">Reading</th>
                  <th className="py-2 text-right font-medium">As of</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(macro.readings).map(([k, v]) => (
                  <tr key={k} className="border-b border-line/60 last:border-0">
                    <td className="py-2">
                      {v.url ? <a href={v.url} target="_blank" rel="noreferrer" className="hover:text-gold-2">{v.label}</a> : v.label}
                      <div className="text-[11px] text-faint">{v.source}</div>
                    </td>
                    <td className="num py-2 text-right">{v.last != null ? v.last.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}{v.yoy != null && <div className="text-[11px] text-faint">{pctS(v.yoy, 1)} y/y</div>}</td>
                    <td className="num py-2 text-right text-dim">{v.change != null ? `${v.change >= 0 ? '+' : ''}${v.change.toFixed(2)}` : '—'}</td>
                    <td className="py-2 pl-3">
                      {v.status === 'unavailable' ? <Tag tone="warn">unavailable</Tag> : <Tag tone={v.reading === 'positive' ? 'up' : v.reading === 'negative' ? 'down' : v.reading === 'uncertain' ? 'warn' : 'dim'}>{v.stale ? 'stale' : v.reading}</Tag>}
                    </td>
                    <td className="py-2 text-right text-xs text-faint">{v.date ? date(Date.parse(v.date), false) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        <div className="space-y-4">
          <Section title="Sector tilt from the data" hint="Sum of the sector impacts of recent moves (rule-based)">
            {tilt.length ? (
              <ul className="space-y-2 text-sm">
                {tilt.map(([s, v]) => (
                  <li key={s} className="flex justify-between"><span className="text-dim">{s}</span><span className={`num ${v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-faint'}`}>{v > 0 ? `+${v}` : v}</span></li>
                ))}
              </ul>
            ) : <p className="text-sm text-dim">No meaningful moves this month.</p>}
          </Section>
          {opps && (
            <Section title="Sector rotation" hint="Relative performance + breadth. Fund flows are not inferred from price.">
              <ul className="space-y-2 text-sm">
                {Object.entries(opps.rotation).sort((a, b) => b[1].rel_3m - a[1].rel_3m).map(([s, v]) => (
                  <li key={s} className="flex items-center justify-between gap-2">
                    <span className="truncate text-dim">{s}</span>
                    <span className="flex items-center gap-2 text-xs">
                      <span className="num">{pctS(v.rel_3m, 1)} 3m</span>
                      {v.breadth_above_ma50 != null && <span className="num text-faint">{Math.round(v.breadth_above_ma50 * 100)}% &gt; 50d</span>}
                      <Tag tone={v.state === 'leading' ? 'up' : v.state === 'improving' ? 'gold' : v.state === 'weakening' ? 'warn' : 'down'}>{v.state}</Tag>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
