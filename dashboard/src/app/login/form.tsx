'use client';
import { useActionState } from 'react';
import { login } from './actions';

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <label className="block">
        <span className="eyebrow">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          className="mt-2 w-full rounded-xl border border-line-2 bg-ink px-4 py-3 text-base text-text outline-none focus:border-gold"
        />
      </label>
      {state?.error && <p className="text-sm text-down">{state.error}</p>}
      <button
        disabled={pending}
        className="w-full rounded-xl bg-gold px-4 py-3 font-semibold text-ink transition hover:bg-gold-2 disabled:opacity-60"
      >
        {pending ? 'Checking…' : 'Enter'}
      </button>
    </form>
  );
}
