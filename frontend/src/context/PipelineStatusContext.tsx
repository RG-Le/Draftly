import { createContext, useContext, useMemo, useState } from 'react';
import type { TriageBannerState } from '../types';

interface PipelineStatusContextValue {
  syncInProgress: boolean;
  triageInProgressThreadIds: string[];
  draftInProgressThreadIds: string[];
  triageBanner: TriageBannerState | null;
  markSyncStarted: () => void;
  markSyncCompleted: () => void;
  markSyncFailed: () => void;
  markTriageStarted: (threadId?: string) => void;
  markTriageCompleted: (threadId?: string) => void;
  markTriageFailed: (threadId?: string) => void;
  markDraftStarted: (threadId?: string) => void;
  markDraftCompleted: (threadId?: string) => void;
  markDraftFailed: (threadId?: string) => void;
  setTriageBanner: (state: TriageBannerState | null) => void;
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
  const [triageBanner, setTriageBanner] = useState<TriageBannerState | null>(null);

  const value = useMemo<PipelineStatusContextValue>(
    () => ({
      syncInProgress,
      triageInProgressThreadIds,
      draftInProgressThreadIds,
      triageBanner,
      markSyncStarted: () => setSyncInProgress(true),
      markSyncCompleted: () => setSyncInProgress(false),
      markSyncFailed: () => setSyncInProgress(false),
      markTriageStarted: (threadId) => setTriageInProgressThreadIds((prev) => addUnique(prev, threadId)),
      markTriageCompleted: (threadId) => setTriageInProgressThreadIds((prev) => removeItem(prev, threadId)),
      markTriageFailed: (threadId) => setTriageInProgressThreadIds((prev) => removeItem(prev, threadId)),
      markDraftStarted: (threadId) => setDraftInProgressThreadIds((prev) => addUnique(prev, threadId)),
      markDraftCompleted: (threadId) => setDraftInProgressThreadIds((prev) => removeItem(prev, threadId)),
      markDraftFailed: (threadId) => setDraftInProgressThreadIds((prev) => removeItem(prev, threadId)),
      setTriageBanner
    }),
    [syncInProgress, triageInProgressThreadIds, draftInProgressThreadIds, triageBanner]
  );

  return <PipelineStatusContext.Provider value={value}>{children}</PipelineStatusContext.Provider>;
}

export function usePipelineStatus() {
  const context = useContext(PipelineStatusContext);
  if (!context) throw new Error('usePipelineStatus must be used within PipelineStatusProvider');
  return context;
}
