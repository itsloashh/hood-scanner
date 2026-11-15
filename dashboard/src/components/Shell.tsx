'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { logout } from '@/app/login/actions';

const ic = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);
const NAV = [
  { href: '/', label: 'Desk', icon: ic(<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z" />) },
  { href: '/coins', label: 'Coins', icon: ic(<><circle cx="12" cy="12" r="8" /><path d="M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4M12 7.5v9" /></>) },
  { href: '/stocks', label: 'Stocks', icon: ic(<><path d="M4 17 9.5 11l3.5 3.5L20 7" /><path d="M15 7h5v5" /></>) },
  { href: '/alerts', label: 'Alerts', icon: ic(<><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></>) },
];
const MORE = [
  { href: '/analysis', label: 'Coin analysis', hint: 'What winning calls had in common' },
  { href: '/scanner', label: 'Coin scanner health', hint: 'Last scan, cuts, data sources' },
  { href: '/stocks/macro', label: 'Economy', hint: 'Rates, inflation, sector rotation' },
  { href: '/stocks/track', label: 'Stock track record', hint: 'Every candidate since discovery + backtest' },
  { href: '/stocks/sources', label: 'Stock data sources', hint: 'What worked on the last run' },
];

function active(path: string, href: string) {
  return href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`) || (href === '/coins' && path.startsWith('/calls'));
}

function useSetting(key: string, initial: string) {
  const [v, setV] = useState(initial);
  useEffect(() => {
    try {
      setV(localStorage.getItem(key) || initial);
    } catch {}
  }, [key, initial]);
  const set = (x: string) => {
    setV(x);
    try {
      localStorage.setItem(key, x);
    } catch {}
    const d = document.documentElement;
    if (key === 'hd-theme') d.dataset.theme = x;
    if (key === 'hd-layout') d.dataset.layout = x;
  };
  return [v, set] as const;
}

function Seg({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="flex rounded-xl border border-line bg-panel-2 p-1">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${value === v ? 'bg-panel text-gold-2 shadow-[var(--shadow-glow)]' : 'text-dim'}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [theme, setTheme] = useSetting('hd-theme', 'light');
  const [layout, setLayout] = useSetting('hd-layout', 'auto');
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 backdrop-blur-sm desk:items-center" onClick={onClose}>
      <div className="card w-full max-w-md rounded-b-none p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] desk:rounded-b-[18px]" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="display text-lg">More</h2>
          <button onClick={onClose} className="btn px-2.5 py-1" aria-label="Close">✕</button>
        </div>
        <div className="space-y-3">
          <div>
            <div className="eyebrow mb-1.5">Layout</div>
            <Seg value={layout} onChange={setLayout} options={[['auto', 'Auto'], ['phone', 'Phone'], ['desktop', 'Desktop']]} />
          </div>
          <div>
            <div className="eyebrow mb-1.5">Theme</div>
            <Seg value={theme} onChange={setTheme} options={[['light', 'Light'], ['dark', 'Dark']]} />
          </div>
        </div>
        <div className="mt-5 space-y-2">
          {MORE.map((m) => (
            <Link key={m.href} href={m.href} onClick={onClose} className="tap flex items-center justify-between rounded-xl border border-line bg-panel px-4 py-3">
              <div>
                <div className="text-sm font-semibold">{m.label}</div>
                <div className="text-xs text-faint">{m.hint}</div>
              </div>
              <span className="text-faint">›</span>
            </Link>
          ))}
        </div>
        <form action={logout} className="mt-5">
          <button className="btn w-full text-down">Sign out</button>
        </form>
      </div>
    </div>
  );
}

export function Shell({ children, updated }: { children: React.ReactNode; updated: string }) {
  const path = usePathname();
  const [more, setMore] = useState(false);
  return (
    <div className="min-h-dvh desk:pl-60">
      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-panel/80 px-4 py-6 backdrop-blur desk:flex">
        <Link href="/" className="mb-8 flex items-center gap-3 px-2">
          <img src="/icon.svg" alt="" className="h-9 w-9 rounded-xl shadow-[var(--shadow-glow)]" />
          <div>
            <div className="display text-lg leading-tight">Hood Desk</div>
            <div className="text-xs text-faint">Coins + stocks</div>
          </div>
        </Link>
        <nav className="space-y-1">
          {NAV.map((n) => {
            const on = active(path, n.href);
            return (
              <Link key={n.href} href={n.href} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${on ? 'bg-gold/10 text-gold-2 shadow-[inset_0_0_0_1px_rgb(var(--color-glow)/0.25)]' : 'text-dim hover:bg-panel-2 hover:text-text'}`}>
                {n.icon}
                {n.label}
              </Link>
            );
          })}
          <button onClick={() => setMore(true)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-dim hover:bg-panel-2 hover:text-text">
            {ic(<><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>)}
            More
          </button>
        </nav>
        <div className="mt-auto flex items-center gap-2 px-3 text-xs text-faint">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-up text-up" />
          Data {updated}
        </div>
      </aside>

      {/* Phone top bar */}
      <header className="sticky top-0 z-30 border-b border-line bg-panel/80 backdrop-blur desk:hidden">
        <div className="mx-auto flex items-center justify-between px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] phone:max-w-[480px]">
          <Link href="/" className="flex items-center gap-2.5">
            <img src="/icon.svg" alt="" className="h-7 w-7 rounded-lg" />
            <span className="display text-lg">Hood Desk</span>
          </Link>
          <div className="flex items-center gap-1.5 text-xs text-faint">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-up text-up" />
            {updated}
          </div>
        </div>
      </header>

      <main className="@container mx-auto max-w-7xl px-4 pb-28 pt-5 phone:max-w-[480px] desk:px-10 desk:pb-12 desk:pt-8">{children}</main>

      {/* Phone tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/90 pb-[env(safe-area-inset-bottom)] backdrop-blur desk:hidden">
        <div className="mx-auto grid grid-cols-5 phone:max-w-[480px]">
          {NAV.map((n) => {
            const on = active(path, n.href);
            return (
              <Link key={n.href} href={n.href} className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium ${on ? 'text-gold-2' : 'text-faint'}`}>
                {n.icon}
                {n.label}
              </Link>
            );
          })}
          <button onClick={() => setMore(true)} className="flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium text-faint">
            {ic(<><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>)}
            More
          </button>
        </div>
      </nav>
      <MoreSheet open={more} onClose={() => setMore(false)} />
    </div>
  );
}
