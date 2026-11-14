export default function Loading() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-9 w-48 rounded-lg bg-panel" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl bg-panel" />
        ))}
      </div>
      <div className="h-64 rounded-xl bg-panel" />
    </div>
  );
}
