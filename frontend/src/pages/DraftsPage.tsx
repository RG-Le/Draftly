import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listDrafts } from '../api/drafts';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { LoadingCard } from '../components/LoadingCard';
import { formatDateTime } from '../lib/format';

const filters = [
  { key: '', label: 'All' },
  { key: 'draft_ready', label: 'Ready' },
  { key: 'draft_edited', label: 'Edited' },
  { key: 'approved', label: 'Approved' },
  { key: 'send_queued', label: 'Queued' },
  { key: 'send_failed', label: 'Failed' },
  { key: 'rejected', label: 'Rejected' }
];

function toneForStatus(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'sent') return 'success';
  if (status === 'approved' || status === 'send_queued') return 'info';
  if (status === 'send_failed') return 'danger';
  if (status === 'draft_edited' || status === 'draft_pending') return 'warning';
  return 'neutral';
}

export function DraftsPage() {
  const [status, setStatus] = useState('');
  const draftsQuery = useQuery({
    queryKey: ['drafts', status],
    queryFn: () => listDrafts(status || undefined)
  });

  const drafts = draftsQuery.data?.drafts || [];

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Draft Queue</h2>
        <div className="chip-group">
          {filters.map((item) => (
            <button
              key={item.key || 'all'}
              onClick={() => setStatus(item.key)}
              className={`chip ${status === item.key ? 'chip-active' : ''}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {draftsQuery.isLoading ? (
        <LoadingCard lines={8} />
      ) : drafts.length === 0 ? (
        <EmptyState
          title="No drafts available"
          description="Drafts appear here after triage/generation is complete."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Thread</th>
                <th>Updated</th>
                <th>Version</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {drafts.map((draft) => (
                <tr key={draft.id}>
                  <td>
                    <Badge label={draft.status} tone={toneForStatus(draft.status)} />
                  </td>
                  <td>{draft.threadSubject || draft.threadId}</td>
                  <td>{formatDateTime(draft.updatedAt)}</td>
                  <td>v{draft.version}</td>
                  <td>
                    <Link
                      to={`/app/inbox/${draft.threadId}`}
                      className="inline-link"
                      onClick={() => window.scrollTo({ left: 0, top: 0, behavior: 'auto' })}
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
