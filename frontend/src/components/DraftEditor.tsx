import { useEffect, useState } from 'react';
import { Button } from './Button';
import { Badge } from './Badge';

interface DraftEditorProps {
  status?: string;
  version?: number;
  value?: string | null;
  loading?: boolean;
  onSave: (value: string) => Promise<void> | void;
  onRegenerate: () => Promise<void> | void;
  onApprove: () => Promise<void> | void;
  onReject: () => Promise<void> | void;
}

function draftTone(status?: string): 'neutral' | 'success' | 'warning' | 'info' | 'danger' {
  if (!status) return 'neutral';
  if (status === 'sent') return 'success';
  if (status === 'approved' || status === 'send_queued') return 'info';
  if (status === 'send_failed') return 'danger';
  if (status === 'draft_pending') return 'warning';
  if (status === 'draft_edited' || status === 'edited') return 'warning';
  return 'neutral';
}

export function DraftEditor({
  status,
  version,
  value,
  loading,
  onSave,
  onRegenerate,
  onApprove,
  onReject
}: DraftEditorProps) {
  const [content, setContent] = useState(value || '');

  useEffect(() => {
    setContent(value || '');
  }, [value]);

  const readOnly = status === 'approved' || status === 'send_queued' || status === 'sent';

  return (
    <div className="draft-editor">
      <div className="draft-editor-head">
        <h3>Draft Workspace</h3>
        <div className="draft-editor-meta">
          <Badge label={status || 'not_generated'} tone={draftTone(status)} />
          {version ? <span>v{version}</span> : null}
        </div>
      </div>

      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Draft content will appear here."
        disabled={readOnly}
      />

      <div className="draft-editor-actions">
        <Button variant="secondary" onClick={() => onSave(content)} loading={loading} disabled={readOnly}>
          Save edits
        </Button>
        <Button variant="ghost" onClick={onRegenerate} loading={loading}>
          Regenerate
        </Button>
        <Button variant="danger" onClick={onReject} loading={loading}>
          Reject
        </Button>
        <Button onClick={onApprove} loading={loading}>
          Approve & Queue Send
        </Button>
      </div>
    </div>
  );
}
