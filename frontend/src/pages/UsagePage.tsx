import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getUsageStats } from '../api/usage';
import { EmptyState } from '../components/EmptyState';
import { LoadingCard } from '../components/LoadingCard';
import { MetricCard } from '../components/MetricCard';
import { formatCurrencyUsd, titleCase } from '../lib/format';
import type { UsageStats } from '../types';

const PERIODS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' }
];

function BarChart({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map(([, v]) => v), 1);

  return (
    <div className="bar-chart">
      {entries.map(([key, value]) => (
        <div key={key} className="bar-row">
          <span className="bar-label">{titleCase(key)}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${Math.round((value / max) * 100)}%` }} />
          </div>
          <span className="bar-value">{value}</span>
        </div>
      ))}
      {entries.length === 0 && <p className="muted">No data for this period.</p>}
    </div>
  );
}

function DraftFunnel({ stats }: { stats: UsageStats }) {
  const steps = [
    { label: 'Generated', value: stats.draftsGenerated },
    { label: 'Approved', value: stats.draftsApproved },
    { label: 'Sent', value: stats.draftsSent }
  ];

  return (
    <div className="funnel">
      {steps.map((step, i) => (
        <div key={step.label} className="funnel-step">
          <div className="funnel-count">{step.value}</div>
          <div className="funnel-label">{step.label}</div>
          {i < steps.length - 1 && <div className="funnel-arrow">→</div>}
        </div>
      ))}
    </div>
  );
}

export function UsagePage() {
  const [period, setPeriod] = useState('30d');

  const statsQuery = useQuery({
    queryKey: ['usage-stats', period],
    queryFn: () => getUsageStats(period)
  });

  const stats = statsQuery.data;
  const totalTokens = stats ? stats.totalInputTokens + stats.totalOutputTokens : 0;

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Usage & Stats</h2>
        <div className="chip-group">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              className={`chip ${period === p.value ? 'chip-active' : ''}`}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {statsQuery.isLoading ? (
        <LoadingCard lines={6} />
      ) : !stats ? (
        <EmptyState
          title="Usage data not available"
          description="The usage API will populate once the /usage endpoint is enabled."
        />
      ) : (
        <>
          <div className="metric-grid">
            <MetricCard
              title="Emails Synced"
              value={String(stats.emailsSynced)}
            />
            <MetricCard
              title="Emails Classified"
              value={String(stats.emailsClassified)}
              hint={
                stats.heuristicClassified || stats.llmClassified
                  ? `${stats.heuristicClassified} heuristic · ${stats.llmClassified} LLM`
                  : undefined
              }
            />
            <MetricCard
              title="Total LLM Cost"
              value={formatCurrencyUsd(stats.totalLlmCostUsd)}
              hint="Triage + drafting combined"
            />
            <MetricCard
              title="Total Tokens"
              value={totalTokens.toLocaleString()}
              hint={`${stats.totalInputTokens.toLocaleString()} in · ${stats.totalOutputTokens.toLocaleString()} out`}
            />
          </div>

          <div className="split-grid">
            <div className="subpanel">
              <h3>Triage Breakdown</h3>
              <BarChart data={stats.triageBreakdown} />
            </div>

            <div className="subpanel">
              <h3>Draft Funnel</h3>
              <DraftFunnel stats={stats} />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
