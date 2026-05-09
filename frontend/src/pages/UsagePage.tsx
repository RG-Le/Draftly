import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getUsageSummary, listUsageRecords } from '../api/usage';
import { EmptyState } from '../components/EmptyState';
import { LoadingCard } from '../components/LoadingCard';
import { MetricCard } from '../components/MetricCard';
import { formatCurrencyUsd, formatDateTime, titleCase } from '../lib/format';

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function UsagePage() {
  const [month, setMonth] = useState(currentMonth());

  const summaryQuery = useQuery({
    queryKey: ['usage-summary', month],
    queryFn: () => getUsageSummary(month)
  });

  const fromDate = `${month}-01`;
  const toDate = `${month}-31`;

  const recordsQuery = useQuery({
    queryKey: ['usage-records', month],
    queryFn: () => listUsageRecords(fromDate, toDate)
  });

  const records = recordsQuery.data?.records || [];
  const breakdownEntries = useMemo(
    () => Object.entries(summaryQuery.data?.breakdown || {}),
    [summaryQuery.data?.breakdown]
  );

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Usage & Cost</h2>
        <label className="month-picker">
          Month
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </label>
      </div>

      {summaryQuery.isLoading ? (
        <LoadingCard lines={5} />
      ) : !summaryQuery.data ? (
        <EmptyState
          title="Usage API not available yet"
          description="The UI is ready and will auto-populate when `/usage` endpoints are enabled."
        />
      ) : (
        <>
          <div className="metric-grid">
            <MetricCard title="Estimated Monthly Cost" value={formatCurrencyUsd(summaryQuery.data.totalEstimatedCost)} />
            <MetricCard title="Currency" value={summaryQuery.data.currency || 'USD'} />
            <MetricCard title="Tracked Records" value={`${records.length}`} />
            <MetricCard title="Period" value={summaryQuery.data.month} />
          </div>

          <div className="split-grid">
            <div className="subpanel">
              <h3>Breakdown</h3>
              {breakdownEntries.length === 0 ? (
                <p className="muted">No breakdown reported for this month yet.</p>
              ) : (
                <ul className="breakdown-list">
                  {breakdownEntries.map(([key, value]) => (
                    <li key={key}>
                      <strong>{titleCase(key)}:</strong> <span>{JSON.stringify(value)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="subpanel">
              <h3>Recent Records</h3>
              {recordsQuery.isLoading ? (
                <LoadingCard lines={4} />
              ) : records.length === 0 ? (
                <p className="muted">No detailed records available for this range.</p>
              ) : (
                <ul className="usage-list">
                  {records.slice(0, 8).map((record, index) => (
                    <li key={`${record.resourceType}-${index}`}>
                      <span>{titleCase(record.resourceType)}</span>
                      <span>{record.quantity}</span>
                      <span>{formatCurrencyUsd(record.estimatedCostUsd || 0)}</span>
                      <span>{formatDateTime(record.usageDate)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
