'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logout } from '@/app/login/actions';

type Item = { href: string; label: string; icon: React.ReactNode; soon?: boolean };

const I = {
  home: (
    <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z" />
  ),
  calls: (
    <>
      <path d="M5 7h14M5 12h14M5 17h9" />
    </>
  ),
  analysis: (
    <>
      <path d="M5 19V11M10 19V6M15 19v-5M20 19V9" />
    </>
  ),
  scanner: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </>
  ),
  stocks: (
    <>
      <path d="M4 17 9.5 11l3.5 3.5L20 7" />
      <path d="M15 7h5v5" />
    </>
  ),
};

const icon = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);

const NAV: Item[] = [
  { href: '/', label: 'Overview', icon: icon(I.home) },
  { href: '/calls', label: 'Calls', icon: icon(I.calls) },
  { href: '/analysis', label: 'Analysis', icon: icon(I.analysis) },
  { href: '/scanner', label: 'Scanner', icon: icon(I.scanner) },
  { href: '/stocks', label: 'Stocks', icon: icon(I.stocks), soon: true },
];

function active(path: string, href: string) {
  return href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);
}

export function Shell({ children, updated }: { children: React.ReactNode; updated: string }) {
  const path = usePathname();
  return (
    <div className="min-h-dvh lg:pl-60">
      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-line bg-panel/60 px-4 py-6 lg:flex">
        <Link href="/" className="mb-8 flex items-center gap-3 px-2">
          <img src="/icon.svg" alt="" className="h-9 w-9" />
          <div>
            <div className="display text-lg leading-tight">Hood Desk</div>
            <div className="text-xs text-faint">Robinhood Chain</div>
          </div>
        </Link>
        <div className="eyebrow mb-2 px-3">Markets</div>
        <nav className="space-y-1">
          {NAV.map((n) => {
            const on = active(path, n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
                  on ? 'bg-panel-2 text-gold-2 shadow-[inset_2px_0_0_var(--color-gold)]' : 'text-dim hover:bg-panel-2 hover:text-text'
                }`}
              >
                {n.icon}
                <span className="flex-1">{n.label}</span>
                {n.soon && <span className="rounded-full border border-line-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-faint">soon</span>}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto space-y-3 px-3 text-xs text-faint">
          <div className="flex items-center gap-2">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />
            Data {updated}
          </div>
          <form action={logout}>
            <button className="text-faint hover:text-text">Sign out</button>
          </form>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-ink/90 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur lg:hidden">
        <Link href="/" className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="" className="h-7 w-7" />
          <span className="display text-lg">Hood Desk</span>
        </Link>
        <div className="flex items-center gap-1.5 text-xs text-faint">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />
          {updated}
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pb-28 pt-5 sm:px-6 lg:px-10 lg:pb-12 lg:pt-10">{children}</main>

      {/* Mobile tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-ink/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {NAV.map((n) => {
          const on = active(path, n.href);
          return (
            <Link key={n.href} href={n.href} className={`flex flex-col items-center gap-1 py-2.5 text-[11px] ${on ? 'text-gold-2' : 'text-faint'}`}>
              {n.icon}
              {n.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
