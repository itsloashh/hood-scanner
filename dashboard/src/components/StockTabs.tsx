'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/stocks', label: 'Opportunities' },
  { href: '/stocks/screener', label: 'Screener' },
  { href: '/stocks/macro', label: 'Economy' },
  { href: '/stocks/track', label: 'Track record' },
  { href: '/stocks/sources', label: 'Data sources' },
];

export function StockTabs() {
  const path = usePathname();
  return (
    <div className="no-scrollbar -mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-line px-4 @2xl:mx-0 @2xl:px-0">
      {TABS.map((t) => {
        const on = t.href === '/stocks' ? path === '/stocks' : path.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition ${on ? 'border-gold text-gold-2' : 'border-transparent text-dim hover:text-text'}`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
