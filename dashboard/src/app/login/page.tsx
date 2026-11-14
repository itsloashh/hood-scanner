import { LoginForm } from './form';

export const metadata = { title: 'Sign in · Hood Desk' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="grid min-h-dvh place-items-center px-5">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-10 w-10" />
          <div>
            <h1 className="display text-2xl">Hood Desk</h1>
            <p className="text-sm text-dim">Private scanner dashboard</p>
          </div>
        </div>
        <div className="card p-6">
          <LoginForm next={next ?? '/'} />
        </div>
      </div>
    </main>
  );
}
