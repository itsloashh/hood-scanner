'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { Row } from '@/lib/stocks';
import { classTone, PROFILE_LABEL, riskTone } from '@/lib/stocks';

const sel = 'rounded-lg border border-line-2 bg-ink px-2.5 py-2 text-sm text-text outline-none focus:border-gold';
type Key = 'score' | 'confidence' | 'mcap' | 'pe' | 'fcf_yield' | 'rev_growth' | 'yield' | 'off_high' | 'upside';

const fmt = {
  usd: (n: number | null) => (n == null ? '—' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`),
  pct: (n: number | null, d = 0) => (n == null ? '—' : `${(n * 100).toFixed(d)}%`),
  num: (n: number | null) => (n == null ? '—' : n.toFixed(1)),
};

export function StockScreener({ rows }: { rows: Row[] }) {
  const [q, setQ] = useState('');
  const [sector, setSector] = useState('all');
  const [cap, setCap] = useState('all');
  const [country, setCountry] = useState('all');
  const [profile, setProfile] = useState('all');
  const [risk, setRisk] = useState('all');
  const [minScore, setMinScore] = useState(0);
  const [minConf, setMinConf] = useState(0);
  const [signals, setSignals] = useState<'any' | 'insider' | 'inst' | 'rr'>('any');
  const [showMicro, setShowMicro] = useState(false);
  const [sort, setSort] = useState<Key>('score');
  const [dir, setDir] = useState<1 | -1>(-1);
  const [limit, setLimit] = useState(100);

  const sectors = useMemo(() => [...new Set(rows.map((r) => r.sector).filter(Boolean))].sort() as string[], [rows]);
  const out = useMemo(() => {
    const s = q.trim().toUpperCase();
    return rows
      .filter((r) => {
        if (s && !r.ticker.includes(s) && !(r.name ?? '').toUpperCase().includes(s)) return false;
        if (!showMicro && r.experimental) return false;
        if (sector !== 'all' && r.sector !== sector) return false;
        if (cap !== 'all' && r.cap !== cap) return false;
        if (country !== 'all' && r.country !== country) return false;
        if (profile !== 'all' && !(profile in r.scores)) return false;
        if (risk !== 'all' && r.risk !== risk) return false;
        if (r.score < minScore || r.confidence < minConf) return false;
        if (signals === 'insider' && !r.insider_buyers_90d) return false;
        if (signals === 'inst' && !r.inst_adds) return false;
        if (signals === 'rr' && !((r.reward_risk ?? 0) >= 2)) return false;
        return true;
      })
      .map((r) => (profile !== 'all' ? { ...r, score: r.scores[profile] ?? r.score } : r))
      .sort((a, b) => (((a[sort] as number | null) ?? -Infinity) > ((b[sort] as number | null) ?? -Infinity) ? 1 : -1) * dir);
  }, [rows, q, sector, cap, country, profile, risk, minScore, minConf, signals, showMicro, sort, dir]);

  const th = (k: Key, label: string) => (
    <th className="px-2 py-2.5 text-right font-medium">
      <button onClick={() => (sort === k ? setDir((d) => (d === 1 ? -1 : 1)) : (setSort(k), setDir(-1)))} className={sort === k ? 'text-gold-2' : 'hover:text-text'}>
        {label}{sort === k && (dir === -1 ? ' ↓' : ' ↑')}
      </button>
    </th>
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticker or name" className={`${sel} w-full @2xl:w-44`} />
        <select value={profile} onChange={(e) => setProfile(e.target.value)} className={sel} aria-label="Strategy">
          <option value="all">Best lens</option><option value="value">Value</option><option value="growth">Growth</option><option value="dividend">Dividend</option>
        </select>
        <select value={sector} onChange={(e) => setSector(e.target.value)} className={sel} aria-label="Sector">
          <option value="all">All sectors</option>{sectors.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={cap} onChange={(e) => setCap(e.target.value)} className={sel} aria-label="Size">
          <option value="all">All sizes</option><option value="large">Large ($10B+)</option><option value="mid">Mid ($2–10B)</option><option value="small">Small ($300M–2B)</option><option value="micro">Micro (experimental)</option>
        </select>
        <select value={country} onChange={(e) => setCountry(e.target.value)} className={sel} aria-label="Country">
          <option value="all">US + Canada</option><option value="US">US</option><option value="CA">Canada</option>
        </select>
        <select value={risk} onChange={(e) => setRisk(e.target.value)} className={sel} aria-label="Risk">
          <option value="all">Any risk</option><option>Low</option><option>Moderate</option><option>High</option><option>Speculative</option>
        </select>
        <select value={signals} onChange={(e) => setSignals(e.target.value as 'any')} className={sel} aria-label="Signals">
          <option value="any">Any signal</option><option value="insider">Insider buying</option><option value="inst">13F additions</option><option value="rr">Reward/risk ≥ 2:1</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-dim">Score ≥ <input type="number" value={minScore} min={0} max={100} step={5} onChange={(e) => setMinScore(+e.target.value)} className={`${sel} w-16`} /></label>
        <label className="flex items-center gap-2 text-sm text-dim">Evidence ≥ <input type="number" value={minConf} min={0} max={100} step={5} onChange={(e) => setMinConf(+e.target.value)} className={`${sel} w-16`} /></label>
        <label className="flex items-center gap-2 text-sm text-dim"><input type="checkbox" checked={showMicro} onChange={(e) => setShowMicro(e.target.checked)} className="accent-[var(--color-gold)]" /> include microcaps</label>
        <span className="num ml-auto text-sm text-faint">{out.length.toLocaleString()} stocks</span>
      </div>

      <div className="card scroll-x">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-line text-left text-xs text-faint">
            <tr>
              <th className="px-3 py-2.5 font-medium">Stock</th>
              {th('score', 'Score')}
              {th('confidence', 'Evidence')}
              <th className="px-2 py-2.5 font-medium">Risk</th>
              {th('mcap', 'Mcap')}
              {th('pe', 'P/E')}
              {th('fcf_yield', 'FCF yld')}
              {th('rev_growth', 'Rev y/y')}
              {th('yield', 'Div yld')}
              {th('off_high', 'Off high')}
              {th('upside', 'Base case')}
            </tr>
          </thead>
          <tbody>
            {out.slice(0, limit).map((r) => (
              <tr key={r.id} className="border-b border-line/60 last:border-0 hover:bg-panel-2/60">
                <td className="px-3 py-2.5">
                  <Link href={`/stocks/${encodeURIComponent(r.id)}`} className="font-semibold hover:text-gold-2">{r.ticker}</Link>
                  {r.country === 'CA' && <span className="ml-1 text-[10px] text-dim">CA</span>}
                  {r.insider_buyers_90d > 0 && <span className="ml-1 text-[10px] text-up">ins</span>}
                  {r.inst_adds > 0 && <span className="ml-1 text-[10px] text-info">13F</span>}
                  {r.quarantined && <span className="ml-1 text-[10px] text-down">quarantine</span>}
                  <div className="max-w-[16rem] truncate text-xs text-faint">{r.name} · {r.sector ?? '—'} · {PROFILE_LABEL[r.profile]}</div>
                </td>
                <td className={`num px-2 text-right ${classTone(r.score)}`}>{Math.round(r.score)}</td>
                <td className="num px-2 text-right text-dim">{r.confidence}</td>
                <td className={`px-2 text-xs ${riskTone(r.risk)}`}>{r.risk}</td>
                <td className="num px-2 text-right text-dim">{fmt.usd(r.mcap)}</td>
                <td className="num px-2 text-right">{fmt.num(r.pe)}</td>
                <td className="num px-2 text-right">{fmt.pct(r.fcf_yield, 1)}</td>
                <td className={`num px-2 text-right ${(r.rev_growth ?? 0) > 0 ? 'text-up' : 'text-dim'}`}>{fmt.pct(r.rev_growth)}</td>
                <td className="num px-2 text-right">{fmt.pct(r.yield, 1)}</td>
                <td className="num px-2 text-right text-dim">{fmt.pct(r.off_high)}</td>
                <td className={`num px-2 text-right ${(r.upside ?? 0) > 0 ? 'text-up' : 'text-dim'}`}>{r.upside != null ? `${r.upside >= 0 ? '+' : ''}${(r.upside * 100).toFixed(0)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {out.length > limit && (
        <button onClick={() => setLimit((l) => l + 200)} className="mt-3 w-full rounded-lg border border-line-2 py-2 text-sm text-dim hover:text-text">
          Show more ({(out.length - limit).toLocaleString()} left)
        </button>
      )}
    </div>
  );
}
