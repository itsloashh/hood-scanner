import Link from 'next/link';
import type { Row } from '@/lib/stocks';
import { classTone, PROFILE_LABEL, riskTone } from '@/lib/stocks';
import { pct, usd } from '@/lib/format';

export function money(n: number | null | undefined, cur = 'USD') {
  if (n == null || !isFinite(n)) return '—';
  const s = usd(n);
  return cur === 'CAD' ? s.replace('$', 'C$') : s;
}

export function pctS(v: number | null | undefined, d = 0) {
  if (v == null || !isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
}

export function num(v: number | null | undefined, d = 1) {
  return v == null || !isFinite(v) ? '—' : v.toFixed(d);
}

// Opportunity score and evidence confidence, always side by side and never blended.
export function ScorePair({ score, confidence, size = 'md' }: { score: number; confidence: number; size?: 'md' | 'lg' }) {
  const big = size === 'lg';
  return (
    <div className="flex items-stretch gap-2">
      <div className={`rounded-lg border border-line-2 ${big ? 'px-4 py-3' : 'px-2.5 py-1.5'}`}>
        <div className="text-[10px] uppercase tracking-wider text-faint">Score</div>
        <div className={`num ${big ? 'text-3xl' : 'text-lg'} ${classTone(score)}`}>{Math.round(score)}</div>
      </div>
      <div className={`rounded-lg border border-line-2 ${big ? 'px-4 py-3' : 'px-2.5 py-1.5'}`}>
        <div className="text-[10px] uppercase tracking-wider text-faint">Evidence</div>
        <div className={`num ${big ? 'text-3xl' : 'text-lg'} ${confidence >= 70 ? 'text-up' : confidence >= 50 ? 'text-text' : 'text-warn'}`}>{Math.round(confidence)}</div>
      </div>
    </div>
  );
}

export function StockRow({ r, rank }: { r: Row; rank?: number }) {
  return (
    <Link href={`/stocks/${encodeURIComponent(r.id)}`} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-panel-2">
      {rank != null && <span className="num w-5 text-xs text-faint">{rank}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{r.ticker}</span>
          {r.country === 'CA' && <span className="rounded border border-line-2 px-1 text-[10px] text-dim">CA</span>}
          {r.insider_buyers_90d > 0 && <span className="rounded border border-up/40 px-1 text-[10px] text-up" title="Open-market insider purchases in 90 days">insider buy</span>}
          {r.inst_adds > 0 && <span className="rounded border border-info/40 px-1 text-[10px] text-info" title="Tracked managers added (13F, delayed)">13F add</span>}
        </div>
        <div className="truncate text-xs text-faint">
          {r.name} · {r.sector ?? '—'} · {r.cap ?? '—'} cap · {PROFILE_LABEL[r.profile]}
        </div>
      </div>
      <div className="hidden text-right text-xs sm:block">
        <div className={riskTone(r.risk)}>{r.risk}</div>
        <div className="text-faint">{money(r.mcap)}</div>
      </div>
      <div className="flex gap-2 text-right">
        <div>
          <div className={`num text-base ${classTone(r.score)}`}>{Math.round(r.score)}</div>
          <div className="text-[10px] text-faint">score</div>
        </div>
        <div>
          <div className="num text-base text-dim">{r.confidence}</div>
          <div className="text-[10px] text-faint">evid.</div>
        </div>
      </div>
    </Link>
  );
}

export function NotReady() {
  return (
    <div className="card p-8 text-center">
      <h2 className="display text-xl">The first research run is in progress</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-dim">
        The stock engine is pulling SEC filings, prices and economic data for every US and Canadian listed company. The first run takes about an hour; after that it updates every weekday after the close.
      </p>
    </div>
  );
}

export const Tag = ({ children, tone = 'dim' }: { children: React.ReactNode; tone?: 'dim' | 'up' | 'down' | 'warn' | 'gold' | 'info' }) => {
  const t = { dim: 'border-line-2 text-dim', up: 'border-up/40 text-up', down: 'border-down/40 text-down', warn: 'border-warn/40 text-warn', gold: 'border-gold/40 text-gold-2', info: 'border-info/40 text-info' }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${t}`}>{children}</span>;
};

export { pct };
