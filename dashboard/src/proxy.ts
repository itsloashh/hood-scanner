import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, validSession } from '@/lib/auth';

export async function proxy(req: NextRequest) {
  const ok = await validSession(req.cookies.get(COOKIE)?.value);
  if (ok) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = req.nextUrl.pathname === '/' ? '' : `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // everything except the login page, Next internals and static icons
  matcher: ['/((?!login|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|robots.txt).*)'],
};
