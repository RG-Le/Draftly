import type { ThreadMessage } from '../types';
import { formatDateTime } from '../lib/format';

export function MessageTimeline({ messages }: { messages: ThreadMessage[] }) {
  return (
    <div className="timeline">
      {messages.map((message) => (
        <article className={`timeline-item ${message.isSentByUser ? 'sent-by-user' : ''}`} key={message.id}>
          <header>
            <div>
              <strong>{message.isSentByUser ? 'You' : message.from}</strong>
              <p>
                To: {message.to.join(', ') || '-'}
                {message.cc.length ? ` | Cc: ${message.cc.join(', ')}` : ''}
              </p>
            </div>
            <time>{formatDateTime(message.receivedAt)}</time>
          </header>
          <div className="timeline-body">
            <p>{message.bodyText || 'No text body available'}</p>
          </div>
        </article>
      ))}
    </div>
  );
}
