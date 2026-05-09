# State, Queries, and Hooks

## 1. Auth state — `AuthContext`

**Persistence:** `lib/storage.ts` → `localStorage` key **`draftly.session.v1`** stores `{ accessToken, refreshToken, user }`.

**API:**

- `isAuthenticated`: derived from truthy `accessToken`.
- `setSession(session)` writes storage + React state.
- `clearSession()` removes storage + resets state (logout).
- `patchUser(partial)` merges user in memory **and** in stored session (`patchStoredSession`).

Hooks that need tokens for REST should rely on **`apiRequest`** in `lib/http.ts` which reads **`getAccessToken()`** from storage (kept in sync with context after login).

## 2. Pipeline UX — `PipelineStatusContext`

Thin in-memory UI state (**not persisted**):

| Flag / method | Use |
|----------------|-----|
| `syncInProgress` | Global “sync running” spinner semantics |
| `triageInProgressThreadIds[]` | Per-thread triage spinner |
| `draftInProgressThreadIds[]` | Per-thread draft spinner |
| `markSync*` / `markTriage*` / `markDraft*` | Called from realtime hook + mutations |

**InboxPage** merges this with **local polling state** (`draftGenerationThreadId`, `triageWatchThreadId`) to enable **TanStack Query `refetchInterval`** while waiting for asynchronous backend pipelines.

Example: when `shouldPollPipelines` is true, `threadsQuery` polls every **5s** and `detailQuery` every **3s**.

## 3. Toasts — `ToastContext`

- `pushToast({ title, description?, tone })` auto-dismisses after **4500ms** via `window.setTimeout`.
- `ToastViewport` (mounted in `App.tsx`) consumes `toasts` for rendering — exact DOM structure/CSS is in **`styles.css`** + `ToastViewport.tsx`.

## 4. TanStack Query — conventions

Established **query keys** (important for realtime invalidations):

| Key | Producer |
|-----|----------|
| `['me']` | `AppLayout` |
| `['connections']` | `AppLayout`, `SettingsPage` |
| `['threads', classification]` | `InboxPage` |
| `['thread-detail', threadId]` | `InboxPage` |
| `['drafts']` | `DraftsPage` + optimistic updates from `InboxPage` |
| `['profile']`, `['preferences']` | `SettingsPage` |
| `['sends']` / usage keys | Sent/Usage pages |

**Optimistic drafts:** `InboxPage` sometimes injects **`pending-{threadId}`** placeholder rows into **`['drafts']`** cache and `thread-detail` cache while regeneration is pending; remove/reconcile when realtime or polling picks up server state.

## 5. `useRealtimeEvents` — Socket.IO hub

Located in **`src/hooks/useRealtimeEvents.ts`**.

- Connects to **`io(getApiBaseUrl(), { transports: ['websocket'], auth: { token: accessToken } })`** — server must authenticate via **Socket.IO handshake** using the JWT.
- Registers many event handlers that:
  - `pushToast` user-visible messages.
  - call `PipelineStatusContext` markers.
  - `invalidateQueries` for `connections`, `threads`, `thread-detail`, `drafts`, `sends`.

**Agents:** If you rename gateway-emitted Socket events, update **every key** in the `handlers` map in parallel with backend emission.

---

### Known defect (agents should fix if touching this file)

The handler for **`triage:failed`** references **`markTriageFailed`**, which **does not exist** on `usePipelineStatus()`. Until fixed, firing that event server-side could throw when the handler runs — add `markTriageFailed` to context or remove the branch.
