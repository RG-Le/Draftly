# Realtime Events (Socket.IO Client)

Implementation: **`frontend/src/hooks/useRealtimeEvents.ts`**.

Activation: **`AppLayout`** calls `useRealtimeEvents(true)` for every authenticated logged-in workspace session.

## Connection

```35:37:frontend/src/hooks/useRealtimeEvents.ts
    const socket: Socket = io(getApiBaseUrl(), {
      transports: ['websocket'],
      auth: { token: accessToken }
    });
```

**Gateway implication:** JWT must be validated from **handshake.auth.token** server-side (`gateway` Socket.IO middleware). If realtime auth fails but REST works, check server socket auth path.

On **connect_error**, user sees toast: realtime unavailable — app relies on polling + manual invalidations.

## Shared side effect — query invalidation

```9:14:frontend/src/hooks/useRealtimeEvents.ts
function invalidateCoreQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['connections'] });
  queryClient.invalidateQueries({ queryKey: ['threads'] });
  queryClient.invalidateQueries({ queryKey: ['thread-detail'] });
  queryClient.invalidateQueries({ queryKey: ['drafts'] });
  queryClient.invalidateQueries({ queryKey: ['sends'] });
}
```

Agents adding new persisted entities surfaced in UI should append appropriate invalidations **here** whenever backend pushes matching events.

## Event catalogue (frontend listeners)

Listed as **literal event names** in `handlers`:

| Socket event(s) | UI toast | Pipeline markers | Invalidate queries |
|-----------------|----------|------------------|---------------------|
| `sync:started` | info | `markSyncStarted` | |
| `sync:completed` | success (or warning if 0 threads) | `markSyncCompleted` | core |
| `sync:failed` | danger | `markSyncFailed` | |
| `triage:started` | info | `markTriageStarted` | |
| `triage_completed` | info | `markTriageCompleted` | core |
| `triage:completed` | duplicate alias | … | … |
| `triage_generated` | info | `markTriageCompleted` | core |
| `triage:generated` | info | `markTriageCompleted` | core |
| `triage:failed` | danger | `markTriageFailed` | |
| `triage:batch_started` | info | | |
| `triage:batch_completed` | — | `setTriageBanner(null)` | optimistic cache update per thread |
| `triage:batch_retrying` | — (banner) | `setTriageBanner({ type: 'retrying', ... })` | |
| `triage:batch_failed` | danger (or banner if permanent) | `setTriageBanner({ type: 'failed', ... })` | |
| `draft:started` | info | `markDraftStarted` | |
| `draft_generated` | success | `markDraftCompleted` | core |
| `draft:generated` | success | `markDraftCompleted` | core |
| `draft:ready` | success | `markDraftCompleted` | core |
| `draft:failed` | danger | `markDraftFailed` | |
| `draft:sending` | info | | |
| `send:success` | success | | core |
| `send:failed` | danger | | |
| `connection:expiring` | warning | | |
| `connection:expired` | warning | | core |
| `profile:initialized` | — | | `['profile']` |
| `profile_generated` | success ("Profile updated!") | | `['profile']` |

### Batch triage events (detail)

**`triage:batch_retrying`** — Emitted when a batch triage attempt fails but will be retried. Payload: `{ attempt, maxAttempts, retryInSeconds }`. The frontend shows a retry banner via `setTriageBanner` with the attempt count and countdown.

**`triage:batch_failed`** (with `permanent: true`) — Emitted when all retry attempts are exhausted. Shows a persistent error banner with thread count affected. The banner includes a "Retry" button (user can trigger manual re-triage from the UI).

**`profile_generated`** — Emitted when the AI profile pipeline completes. Invalidates the `['profile']` query cache and shows a success toast: "Your writing profile has been regenerated."

**`sync:completed`** — Now shows a **warning** toast ("No new emails — try syncing with more days") if `newThreads === 0 && updatedThreads === 0`. Otherwise shows a success toast with counts.

**Backend coherence:** Celery/redis publisher emits **`draft_generated`** (underscore) per AI pipeline docs; **`triage_completed`** overlaps gateway naming inconsistencies — tolerate both underscores and colon-delimited conventions until unified.
