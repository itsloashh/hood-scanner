import Link from 'next/link';
import type { Call, Status, Tier } from '@/lib/calls';
import { x } from '@/lib/format';

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 lg:mb-8">
      <div>
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h1 className="display text-3xl leading-tight lg:text-4xl">{title}</h1>
      </div>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'up' | 'down' | 'gold' }) {
  const c = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : tone === 'gold' ? 'text-gold-2' : 'text-text';
  return (
    <div className="card p-4 lg:p-5">
      <div className="eyebrow">{label}</div>
      <div className={`num mt-2 text-2xl font-medium lg:text-[1.7rem] ${c}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-dim">{sub}</div>}
    </div>
  );
}

export function Section({ title, hint, children, className = '', action }: { title: string; hint?: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <section className={`card min-w-0 p-4 lg:p-6 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-lg">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-dim">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export const TIER_META: Record<Tier, { label: string; cls: string; color: string }> = {
  watch: { label: 'Watch', cls: 'border-info/40 text-info bg-info/10', color: 'var(--color-info)' },
  buy: { label: 'Buy zone', cls: 'border-up/40 text-up bg-up/10', color: 'var(--color-up)' },
  ignition: { label: 'Ignition', cls: 'border-warn/40 text-warn bg-warn/10', color: 'var(--color-warn)' },
  pump: { label: 'Pump', cls: 'border-violet/40 text-violet bg-violet/10', color: 'var(--color-violet)' },
};

export function TierBadge({ tier }: { tier: Tier }) {
  const m = TIER_META[tier] ?? TIER_META.watch;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>{m.label}</span>;
}

export const STATUS_META: Record<Status, { label: string; cls: string }> = {
  win: { label: '3× win', cls: 'text-up' },
  stopped: { label: 'Stopped −50%', cls: 'text-down' },
  expired: { label: 'Expired', cls: 'text-faint' },
  open: { label: 'Open', cls: 'text-dim' },
};

export function Outcome({ c }: { c: Call }) {
  if (c.status === 'win') return <span className="text-up">3× win</span>;
  if (c.hit2x && c.status !== 'stopped') return <span className="text-gold-2">Hit 2×</span>;
  if (c.status === 'stopped') return <span className="text-down">Stopped{c.hit2x ? ' (after 2×)' : ''}</span>;
  if (c.status === 'expired') return <span className="text-faint">Expired</span>;
  return <span className="text-dim">Open</span>;
}

export function Mult({ v, strong }: { v: number | null; strong?: boolean }) {
  if (v == null) return <span className="num text-faint">—</span>;
  const c = v >= 2 ? 'text-gold-2' : v >= 1.05 ? 'text-up' : v <= 0.5 ? 'text-down' : 'text-dim';
  return <span className={`num ${c} ${strong ? 'font-semibold' : ''}`}>{x(v)}</span>;
}

export function CoinLink({ c }: { c: Pick<Call, 'token' | 'symbol' | 'pref'> }) {
  return (
    <Link href={`/calls/${c.token}`} className="font-semibold text-text hover:text-gold-2">
      ${c.symbol}
      {c.pref === 'follow' && <span className="ml-1 text-gold" title="Followed">★</span>}
      {c.pref === 'mute' && <span className="ml-1 text-faint" title="Muted">⦸</span>}
    </Link>
  );
}

export function Pill({ children, tone = 'dim' }: { children: React.ReactNode; tone?: 'dim' | 'up' | 'down' | 'gold' | 'warn' }) {
  const t = { dim: 'border-line-2 text-dim', up: 'border-up/40 text-up', down: 'border-down/40 text-down', gold: 'border-gold/40 text-gold-2', warn: 'border-warn/40 text-warn' }[tone];
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${t}`}>{children}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line-2 p-6 text-center text-sm text-dim">{children}</div>;
}
