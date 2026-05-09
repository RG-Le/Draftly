import { createContext, useContext, useMemo, useState } from 'react';

interface PipelineStatusContextValue {
  syncInProgress: boolean;
  triageInProgressThreadIds: string[];
  draftInProgressThreadIds: string[];
  markSyncStarted: () => void;
  markSyncCompleted: () => void;
  markSyncFailed: () => void;
  markTriageStarted: (threadId?: string) => void;
  markTriageCompleted: (threadId?: string) => void;
  markTriageFailed: (threadId?: string) => void;
  markDraftStarted: (threadId?: string) => void;
  markDraftCompleted: (threadId?: string) => void;
  markDraftFailed: (threadId?: string) => void;
}

const PipelineStatusContext = createContext<PipelineStatusContextValue | undefined>(undefined);

function addUnique(items: string[], next?: string): string[] {
  if (!next) return items;
  if (items.includes(next)) return items;
  return [...items, next];
}

function removeItem(items: string[], value?: string): string[] {
  if (!value) return items;
  return items.filter((item) => item !== value);
}

export function PipelineStatusProvider({ children }: { children: React.ReactNode }) {
  const [syncInProgress, setSyncInProgress] = useState(false);
  const [triageInProgressThreadIds, setTriageInProgressThreadIds] = useState<string[]>([]);
  const [draftInProgressThreadIds, setDraftInProgressThreadIds] = useState<string[]>([]);

  const value = useMemo<PipelineStatusContextValue>(
    () => ({
      syncInProgress,
      triageInProgressThreadIds,
      draftInProgressThreadIds,
      markSyncStarted: () => setSyncInProgress(true),
      markSyncCompleted: () => setSyncInProgress(false),
      markSyncFailed: () => setSyncInProgress(false),
      markTriageStarted: (threadId) => setTriageInProgressThreadIds((prev) => addUnique(prev, threadId)),
      markTriageCompleted: (threadId) => setTriageInProgressThreadIds((prev) => removeItem(prev, threadId)),
      markTriageFailed: (threadId) => setTriageInProgressThreadIds((prev) => removeItem(prev, threadId)),
      markDraftStarted: (threadId) => setDraftInProgressThreadIds((prev) => addUnique(prev, threadId)),
      markDraftCompleted: (threadId) => setDraftInProgressThreadIds((prev) => removeItem(prev, threadId)),
      markDraftFailed: (threadId) => setDraftInProgressThreadIds((prev) => removeItem(prev, threadId))
    }),
    [syncInProgress, triageInProgressThreadIds, draftInProgressThreadIds]
  );

  return <PipelineStatusContext.Provider value={value}>{children}</PipelineStatusContext.Provider>;
}

export function usePipelineStatus() {
  const context = useContext(PipelineStatusContext);
  if (!context) throw new Error('usePipelineStatus must be used within PipelineStatusProvider');
  return context;
}
