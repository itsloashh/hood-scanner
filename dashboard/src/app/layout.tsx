import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hood Desk',
  description: 'Private research desk for coin and stock calls',
  robots: { index: false, follow: false },
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
  appleWebApp: { capable: true, title: 'Hood Desk', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  themeColor: '#f4f6fb',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// Applies the saved theme + layout before first paint (no flash)
const boot = `try{var d=document.documentElement;d.dataset.theme=localStorage.getItem('hd-theme')||'light';d.dataset.layout=localStorage.getItem('hd-layout')||'auto'}catch(e){document.documentElement.dataset.layout='auto'}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" data-layout="auto" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: boot }} />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
