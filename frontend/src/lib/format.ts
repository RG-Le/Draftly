export function formatDateTime(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

export function formatRelativeTime(value?: string | null): string {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const diffMs = date.getTime() - Date.now();
  const minutes = Math.round(diffMs / 60000);
  const absMinutes = Math.abs(minutes);

  if (absMinutes < 1) return 'just now';
  if (absMinutes < 60) return `${Math.abs(minutes)}m ${minutes >= 0 ? 'from now' : 'ago'}`;

  const hours = Math.round(minutes / 60);
  const absHours = Math.abs(hours);
  if (absHours < 24) return `${absHours}h ${hours >= 0 ? 'from now' : 'ago'}`;

  const days = Math.round(hours / 24);
  return `${Math.abs(days)}d ${days >= 0 ? 'from now' : 'ago'}`;
}

export function titleCase(input: string): string {
  return input
    .replace(/[_-]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((chunk) => chunk[0].toUpperCase() + chunk.slice(1))
    .join(' ');
}

export function formatCurrencyUsd(value?: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4
  }).format(value ?? 0);
}
