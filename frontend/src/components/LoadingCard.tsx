export function LoadingCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="loading-card">
      {Array.from({ length: lines }).map((_, index) => (
        <div className="loading-line" key={index} />
      ))}
    </div>
  );
}
