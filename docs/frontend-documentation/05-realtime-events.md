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
| `sync:completed` | success | `markSyncCompleted` | core |
| `sync:failed` | danger | `markSyncFailed` | |
| `triage:started` | info | `markTriageStarted` | |
| `triage_completed` | info | `markTriageCompleted` | core |
| `triage:completed` | duplicate alias | … | … |
| `triage:failed` | danger | **broken**: references undefined `markTriageFailed` | See [03-state-queries-and-hooks.md](./03-state-queries-and-hooks.md) |
| `draft:started` | info | `markDraftStarted` | |
| `draft_generated` | success | `markDraftCompleted` | core |
| `draft:ready` | alias style | … | … |
| `draft:failed` | danger | `markDraftFailed` | |
| `draft:sending` | info | | |
| `send:success` | success | | core |
| `send:failed` | danger | | |
| `connection:expiring` | warning | | |
| `connection:expired` | warning | | core |

**Backend coherence:** Celery/redis publisher emits **`draft_generated`** (underscore) per AI pipeline docs; **`triage_completed`** overlaps gateway naming inconsistencies — tolerate both underscores and colon-delimited conventions until unified.
