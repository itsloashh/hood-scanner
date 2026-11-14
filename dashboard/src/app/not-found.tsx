import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-5 text-center">
      <div>
        <h1 className="display text-3xl">Not found</h1>
        <p className="mt-2 text-dim">That coin isn’t in the bot’s call history.</p>
        <Link href="/calls" className="mt-4 inline-block text-gold">Back to calls</Link>
      </div>
    </main>
  );
}
