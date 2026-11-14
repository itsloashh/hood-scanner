'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE, SESSION_DAYS, checkPassword, makeSession } from '@/lib/auth';

export async function login(_: { error?: string } | undefined, form: FormData) {
  const pw = String(form.get('password') ?? '');
  const next = String(form.get('next') ?? '/');
  if (!process.env.DASHBOARD_PASSWORD) return { error: 'The dashboard password isn’t set on the server yet.' };
  if (!(await checkPassword(pw))) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return { error: 'Wrong password.' };
  }
  (await cookies()).set(COOKIE, await makeSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export async function logout() {
  (await cookies()).delete(COOKIE);
  redirect('/login');
}
