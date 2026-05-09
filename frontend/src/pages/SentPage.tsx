import { useQuery } from '@tanstack/react-query';
import { listSendHistory } from '../api/history';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { LoadingCard } from '../components/LoadingCard';
import { formatDateTime } from '../lib/format';

function tone(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'sent' || status === 'success') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'pending' || status === 'processing') return 'warning';
  return 'neutral';
}

export function SentPage() {
  const sendsQuery = useQuery({
    queryKey: ['sends'],
    queryFn: () => listSendHistory()
  });

  const sends = sendsQuery.data?.sends || [];

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Send History</h2>
      </div>

      {sendsQuery.isLoading ? (
        <LoadingCard lines={6} />
      ) : sends.length === 0 ? (
        <EmptyState
          title="No send attempts yet"
          description="Approved drafts will appear here once dispatch is triggered."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Thread</th>
                <th>Attempt</th>
                <th>Queued</th>
                <th>Completed</th>
              </tr>
            </thead>
            <tbody>
              {sends.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Badge label={item.status} tone={tone(item.status)} />
                  </td>
                  <td>{item.threadSubject || '-'}</td>
                  <td>{item.attemptNumber || 1}</td>
                  <td>{formatDateTime(item.queuedAt)}</td>
                  <td>{formatDateTime(item.completedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
