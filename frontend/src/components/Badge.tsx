import { titleCase } from '../lib/format';

type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';

interface BadgeProps {
  label: string;
  tone?: Tone;
}

export function Badge({ label, tone = 'neutral' }: BadgeProps) {
  return <span className={`badge badge-${tone}`}>{titleCase(label)}</span>;
}
