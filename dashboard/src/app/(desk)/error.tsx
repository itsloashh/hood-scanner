'use client';
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card mx-auto max-w-md p-6 text-center">
      <h2 className="display text-xl">Couldn’t load the scanner data</h2>
      <p className="mt-2 text-sm text-dim">GitHub may be slow for a moment. Nothing is lost.</p>
      <button onClick={reset} className="mt-4 rounded-lg bg-gold px-4 py-2 font-semibold text-ink">
        Try again
      </button>
    </div>
  );
}
