'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { Call, Tier } from '@/lib/calls';
import { CoinLink, Mult, Outcome, TierBadge } from './ui';
import { date, price, usd } from '@/lib/format';

type SortKey = 'firstAt' | 'peakX' | 'nowX' | 'score' | 'mcapAtCall';
type OutcomeF = 'all' | '2x' | 'win' | 'stopped' | 'open' | 'halved';

const sel = 'rounded-lg border border-line-2 bg-ink px-2.5 py-2 text-sm text-text outline-none focus:border-gold';

export function CallsTable({ calls, initial }: { calls: Call[]; initial?: { outcome?: OutcomeF; lane?: string } }) {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState<'all' | Tier>('all');
  const [lane, setLane] = useState(initial?.lane ?? 'all');
  const [kind, setKind] = useState('all');
  const [outcome, setOutcome] = useState<OutcomeF>(initial?.outcome ?? 'all');
  const [followed, setFollowed] = useState(false);
  const [sort, setSort] = useState<SortKey>('firstAt');
  const [dir, setDir] = useState<1 | -1>(-1);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out = calls.filter((c) => {
      if (s && !c.symbol.toLowerCase().includes(s) && !c.token.includes(s)) return false;
      if (tier !== 'all' && !c.events.some((e) => e.tier === tier)) return false;
      if (lane !== 'all' && c.lane !== lane) return false;
      if (kind !== 'all' && c.kind !== kind) return false;
      if (followed && c.pref !== 'follow') return false;
      if (outcome === '2x' && !c.hit2x) return false;
      if (outcome === 'win' && c.status !== 'win') return false;
      if (outcome === 'stopped' && c.status !== 'stopped') return false;
      if (outcome === 'open' && c.status !== 'open') return false;
      if (outcome === 'halved' && !c.halved) return false;
      return true;
    });
    return out.sort((a, b) => ((a[sort] ?? -Infinity) > (b[sort] ?? -Infinity) ? 1 : -1) * dir);
  }, [calls, q, tier, lane, kind, outcome, followed, sort, dir]);

  function head(k: SortKey, label: string, cls = '') {
    const on = sort === k;
    return (
      <th className={`px-3 py-2.5 font-medium ${cls}`}>
        <button
          onClick={() => (on ? setDir((d) => (d === 1 ? -1 : 1)) : (setSort(k), setDir(-1)))}
          className={`inline-flex items-center gap-1 ${on ? 'text-gold-2' : 'hover:text-text'}`}
        >
          {label}
          {on && <span>{dir === -1 ? '↓' : '↑'}</span>}
        </button>
      </th>
    );
  }

  function exportCsv() {
    const cols = ['symbol', 'token', 'lane', 'kind', 'firstTier', 'firstAt', 'firstPrice', 'mcapAtCall', 'score', 'watchAt', 'buyAt', 'ignitionAt', 'pumpAt', 'peakX', 'lowX', 'nowX', 'status', 'hit2x'];
    const iso = (v: unknown) => (typeof v === 'number' && v > 1e12 ? new Date(v).toISOString() : v);
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => JSON.stringify(iso((r as Record<string, unknown>)[c]) ?? '')).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `calls-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ticker or address" className={`${sel} w-full sm:w-56`} />
        <select value={outcome} onChange={(e) => setOutcome(e.target.value as OutcomeF)} className={sel} aria-label="Outcome">
          <option value="all">All outcomes</option>
          <option value="2x">Hit 2×</option>
          <option value="win">3× wins</option>
          <option value="open">Open</option>
          <option value="stopped">Stopped −50%</option>
          <option value="halved">Fell 50%+ at some point</option>
        </select>
        <select value={tier} onChange={(e) => setTier(e.target.value as 'all' | Tier)} className={sel} aria-label="Alert type">
          <option value="all">All alert types</option>
          <option value="watch">Watch</option>
          <option value="buy">Buy zone</option>
          <option value="ignition">Ignition</option>
          <option value="pump">Pump</option>
        </select>
        <select value={lane} onChange={(e) => setLane(e.target.value)} className={sel} aria-label="Lane">
          <option value="all">Both lanes</option>
          <option value="micro">Micro ($5k–333k)</option>
          <option value="quality">Quality ($333k–25M)</option>
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={sel} aria-label="Type">
          <option value="all">Meme + utility</option>
          <option value="meme">Meme</option>
          <option value="utility">Utility</option>
        </select>
        <label className="flex cursor-pointer items-center gap-2 px-1 text-sm text-dim">
          <input type="checkbox" checked={followed} onChange={(e) => setFollowed(e.target.checked)} className="accent-[var(--color-gold)]" />
          Followed
        </label>
        <div className="ml-auto flex items-center gap-3 text-sm text-faint">
          <span className="num">{rows.length} calls</span>
          <button onClick={exportCsv} className="rounded-lg border border-line-2 px-2.5 py-1.5 text-xs text-dim hover:text-text">
            Export CSV
          </button>
        </div>
      </div>

      {/* Desktop table */}
      <div className="card scroll-x hidden md:block">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="border-b border-line text-left text-xs text-faint">
            <tr>
              <th className="px-3 py-2.5 font-medium">Coin</th>
              <th className="px-3 py-2.5 font-medium">First alert</th>
              {head('firstAt', 'Called')}
              <th className="px-3 py-2.5 font-medium">Call price</th>
              {head('mcapAtCall', 'Mcap', 'text-right')}
              {head('score', 'Score', 'text-right')}
              <th className="px-3 py-2.5 font-medium">Timeline</th>
              {head('peakX', 'Peak', 'text-right')}
              {head('nowX', 'Now', 'text-right')}
              <th className="px-3 py-2.5 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.token} className="border-b border-line/60 last:border-0 hover:bg-panel-2/60">
                <td className="px-3 py-3">
                  <CoinLink c={c} />
                  <div className="text-xs text-faint">
                    {c.lane} · {c.kind}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <TierBadge tier={c.firstTier} />
                </td>
                <td className="px-3 py-3 text-dim">{date(c.firstAt)}</td>
                <td className="num px-3 py-3 text-dim">{price(c.firstPrice)}</td>
                <td className="num px-3 py-3 text-right text-dim">{usd(c.mcapAtCall)}</td>
                <td className="num px-3 py-3 text-right">{c.bestScore ?? '—'}</td>
                <td className="px-3 py-3">
                  <div className="flex gap-1">
                    {(['watch', 'buy', 'ignition', 'pump'] as Tier[]).map((t) => {
                      const at = c[`${t}At` as 'watchAt'];
                      return (
                        <span
                          key={t}
                          title={at ? `${t}: ${date(at)}` : `no ${t} alert`}
                          className={`h-2 w-5 rounded-full ${at ? '' : 'bg-line'}`}
                          style={at ? { background: { watch: 'var(--color-info)', buy: 'var(--color-up)', ignition: 'var(--color-warn)', pump: 'var(--color-violet)' }[t] } : undefined}
                        />
                      );
                    })}
                  </div>
                </td>
                <td className="px-3 py-3 text-right">
                  <Mult v={c.peakX} strong />
                </td>
                <td className="px-3 py-3 text-right">
                  <Mult v={c.nowX} />
                </td>
                <td className="px-3 py-3">
                  <Outcome c={c} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="p-8 text-center text-sm text-dim">No calls match these filters.</div>}
      </div>

      {/* Mobile cards */}
      <div className="space-y-2.5 md:hidden">
        {rows.map((c) => (
          <Link key={c.token} href={`/calls/${c.token}`} className="card block p-4 active:bg-panel-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold">
                  ${c.symbol}
                  {c.pref === 'follow' && <span className="ml-1 text-gold">★</span>}
                </div>
                <div className="mt-0.5 text-xs text-faint">
                  {date(c.firstAt)} · {c.lane} · {c.kind}
                </div>
              </div>
              <TierBadge tier={c.firstTier} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <div>
                <div className="text-[11px] text-faint">Peak</div>
                <Mult v={c.peakX} strong />
              </div>
              <div>
                <div className="text-[11px] text-faint">Now</div>
                <Mult v={c.nowX} />
              </div>
              <div>
                <div className="text-[11px] text-faint">Outcome</div>
                <Outcome c={c} />
              </div>
            </div>
          </Link>
        ))}
        {!rows.length && <div className="card p-6 text-center text-sm text-dim">No calls match these filters.</div>}
      </div>
    </div>
  );
}
