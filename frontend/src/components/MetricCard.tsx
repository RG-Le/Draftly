interface MetricCardProps {
  title: string;
  value: string;
  hint?: string;
}

export function MetricCard({ title, value, hint }: MetricCardProps) {
  return (
    <div className="metric-card">
      <p className="metric-title">{title}</p>
      <p className="metric-value">{value}</p>
      {hint ? <p className="metric-hint">{hint}</p> : null}
    </div>
  );
}
