import { Link } from 'react-router-dom';
import type { ThreadSummary } from '../types';
import { formatDateTime } from '../lib/format';
import { Badge } from './Badge';

interface ThreadListProps {
  threads: ThreadSummary[];
  selectedThreadId?: string;
  pendingTriageThreadIds?: string[];
  pendingDraftThreadIds?: string[];
}

function triageTone(classification?: string): 'info' | 'warning' | 'success' | 'danger' | 'neutral' {
  if (!classification) return 'neutral';
  if (classification === 'reply_needed') return 'warning';
  if (classification === 'promotions') return 'info';
  if (classification === 'info') return 'neutral';
  if (classification === 'informational_no_action') return 'info';
  if (classification === 'notification_or_subscription') return 'neutral';
  if (classification === 'cc_or_bulk_low_priority') return 'neutral';
  return 'neutral';
}

export function ThreadList({
  threads,
  selectedThreadId,
  pendingTriageThreadIds = [],
  pendingDraftThreadIds = []
}: ThreadListProps) {
  return (
    <div className="thread-list">
      {threads.map((thread) => (
        // Fall back to "pending" UI when realtime says a pipeline is running but list data hasn't been joined yet.
        // This keeps inbox usable during triage/draft processing.
        <Link
          key={thread.id}
          to={`/app/inbox/${thread.id}`}
          className={`thread-item ${selectedThreadId === thread.id ? 'thread-item-active' : ''}`}
        >
          <div className="thread-item-head">
            <h4>{thread.subject || '(No subject)'}</h4>
            <span>{formatDateTime(thread.lastMessageAt)}</span>
          </div>
          <p className="thread-item-meta">
            {thread.participants?.slice(0, 2).map((item) => item.email).join(', ') || 'No participants'}
          </p>
          <div className="thread-item-foot">
            {pendingTriageThreadIds.includes(thread.id) && !thread.triage?.classification ? (
              <Badge label="triage_pending" tone="warning" />
            ) : (
              <Badge label={thread.triage?.classification || 'unclassified'} tone={triageTone(thread.triage?.classification)} />
            )}
            {pendingDraftThreadIds.includes(thread.id) && !thread.latestDraft ? (
              <Badge label="draft_pending" tone="warning" />
            ) : null}
            <span>{thread.messageCount} messages</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
