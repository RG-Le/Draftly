# Draftly Frontend Architecture (Vite + React + TS)

This document captures the current frontend architecture, the integration contract assumptions with the backend, and a summary of the key frontend work completed so far. It is intended to help multiple AI agents (or humans) make small, safe changes without rediscovering context.

## 1. Repo Layout

- `frontend/`
- `frontend/src/`
- `frontend/src/api/` API wrappers and response mapping
- `frontend/src/components/` UI building blocks
- `frontend/src/context/` cross-cutting state (auth, toasts, pipeline status)
- `frontend/src/hooks/` realtime socket integration and other hooks
- `frontend/src/lib/` shared helpers (HTTP client, storage, error formatting, formatting utilities)
- `frontend/src/pages/` route-level screens
- `frontend/src/styles.css` global design system + page/component styles

## 2. Tech Stack

- React + TypeScript
- Vite for dev/build
- React Router for routing
- TanStack Query (React Query) for server state and caching
- Socket.IO client for realtime events
- Vanilla CSS with CSS variables + structured classnames

## 3. Routing & Page Structure

Routes are declared in `frontend/src/App.tsx`.

- Public:
  - `/` Landing + local login/register + Google login button
  - `/auth/callback` Google login callback handler (auth session)
  - `/app/oauth/callback` OAuth connector callback handler (Gmail connect/reconnect)
- Protected (wrapped by `RequireAuth`):
  - `/app/inbox` inbox thread list + detail
  - `/app/inbox/:threadId` opens specific thread detail
  - `/app/drafts` draft queue table
  - `/app/sent` send history
  - `/app/usage` usage page
  - `/app/settings` connection management + preferences + writing profile

The protected pages share the application chrome via `frontend/src/pages/AppLayout.tsx`, which renders:

- `AppShell` (sidebar nav)
- `ConnectionBanner` (Gmail connect/sync state)
- `Outlet` (page content)

## 4. Global State

### 4.1 Auth

`frontend/src/context/AuthContext.tsx` stores:

- `user`
- `accessToken`
- `refreshToken`

Session persistence is handled in `frontend/src/lib/storage.ts` with a single key:

- `draftly.session.v1`

### 4.2 Toasts

`frontend/src/context/ToastContext.tsx` provides ephemeral notifications and is rendered by:

- `frontend/src/components/ToastViewport.tsx`

### 4.3 Pipeline Status (Sync/Triage/Draft)

`frontend/src/context/PipelineStatusContext.tsx` is the "single source of truth" for in-progress state driven by Socket.IO events:

- `syncInProgress: boolean`
- `triageInProgressThreadIds: string[]`
- `draftInProgressThreadIds: string[]`

This context exists to prevent the UI from "flying blind" and over-polling or encouraging users to spam actions (which previously caused rate-limit errors).

The provider is mounted in `frontend/src/main.tsx`.

## 5. Networking Layer

### 5.1 HTTP Client

`frontend/src/lib/http.ts` provides `apiRequest()` with:

- automatic JSON parsing
- auth header injection (Bearer token)
- refresh-token fallback (if applicable in this app)
- consistent error wrapper (`ApiError`)

`frontend/src/lib/api-error.ts` provides `getApiErrorMessage()` for end-user messages.

### 5.2 API Modules (src/api)

Key modules:

- `src/api/auth.ts` local login/register + Google callback completion + `/auth/me`
- `src/api/connections.ts` list/connect/reconnect + sync + disconnect + connection status helpers
- `src/api/inbox.ts` list threads + get thread detail + triage/draft actions
- `src/api/drafts.ts` list drafts + fallback behavior when drafts endpoint is missing
- `src/api/history.ts` send history
- `src/api/profile.ts` profile + preferences

#### 5.2.1 "Sticky fallback modes"

Some backend endpoints exist in both legacy and modern forms. The frontend uses a "sticky mode" approach: once a modern/legacy endpoint is detected to work, the client sticks to it to avoid extra calls and reduce 404/405 noise.

Examples:

- `connections.ts`: `connectionsApiMode`
- `inbox.ts`: `inboxApiMode`, `inboxModernRouteMode`

This was added to reduce accidental amplification of backend rate limits.

## 6. Realtime (Socket.IO) Integration

`frontend/src/hooks/useRealtimeEvents.ts`:

- connects to the backend Socket.IO server using `accessToken`
- listens for events and:
  - updates `PipelineStatusContext`
  - shows toasts for key milestones
  - invalidates React Query caches for `connections`, `threads`, `thread-detail`, `drafts`, `sends`

Events supported (includes aliases for backward compatibility):

- Sync: `sync:started`, `sync:completed`, `sync:failed`
- Triage: `triage:started`, `triage:completed`, `triage:generated`, `triage_completed`, `triage_generated`, `triage:failed`
- Draft: `draft:started`, `draft:ready`, `draft:generated`, `draft_generated`, `draft:failed`
- Send: `draft:sending`, `send:success`, `send:failed`
- Connection: `connection:expiring`, `connection:expired`

## 7. Inbox UX & Data Flow

`frontend/src/pages/InboxPage.tsx` is a two-column workspace:

- Left: thread list with category chips (filters)
- Right: thread detail + message timeline + draft editor

### 7.1 Categories (Taxonomy)

Current UI expects the backend to use these category IDs:

- `reply_needed` (label: Reply Needed)
- `promotions` (label: Promotions)
- `info` (label: Info (FYI))

Legacy/transition values are still tolerated because the type union includes `string`, but the chips and tones are optimized for the 3-category contract.

### 7.2 Category Filtering

Thread list fetch is:

- `listThreads({ category })`

Implementation in `src/api/inbox.ts` tries:

1. `GET /api/v1/inbox` with `category` query
2. fallback: `GET /api/v1/inbox/threads` with `classification` query
3. legacy fallback: `GET /api/v1/connections/gmail/threads` (no category filtering)

If the backend is returning legacy threads without triage joined, the UI will show a "backend-limited" warning that filters may not work.

### 7.3 Thread Detail

Thread detail fetch:

- modern: `GET /api/v1/inbox/threads/:id`
- legacy: `GET /api/v1/connections/gmail/threads/:id` plus triage/draft endpoints

Additionally, even when modern detail is available, the frontend may enrich missing triage/draft by calling legacy per-thread endpoints. This was added to make "draft not visible" less likely during backend transition periods.

### 7.4 Draft Generation UX

When a user clicks Generate/Regenerate:

- frontend calls `POST /api/v1/connections/gmail/threads/:id/draft`
- shows `draft_pending` locally
- listens for `draft_generated` or `draft:generated` (or `draft:ready`)
- invalidates caches to refresh content

Because the backend now upserts drafts, the frontend avoids "draft cleanup" logic.

### 7.5 Manual Re-triage (Re-classify)

Inbox detail header includes a "Re-classify" button.

- calls `POST /api/v1/connections/:type/threads/:id/triage`
- marks triage as pending (`triage_pending`)
- waits for triage events to complete and refresh

## 8. Connections UX & OAuth

### 8.1 Connect / Reconnect

UI initiates connect via:

- `GET /api/v1/connections/connect/gmail?redirect_uri=<current page URL>`
- `GET /api/v1/connections/reconnect/gmail?redirect_uri=<current page URL>` (alias route)

Passing `redirect_uri` is critical: if it is `null`, the backend falls back to returning JSON in the browser rather than redirecting.

### 8.2 Connected vs Inactive vs Revoked

The frontend treats:

- `active` and `isUsable === true` as truly connected
- `inactive` as "connect required" (first-time or reset user)
- `revoked`/`expired`/`error` as "reconnect required"

This logic is centralized in `src/api/connections.ts`:

- `isConnectionActive()`
- `needsReconnect()`
- `needsInitialConnection()`

## 9. Drafts Page UX

`frontend/src/pages/DraftsPage.tsx` shows a table of drafts (via `src/api/drafts.ts`).

- Clicking Open routes to `/app/inbox/:threadId`.
- The Inbox route uses CSS constraints and a scroll reset to avoid horizontal scroll artifacts when switching pages.

## 10. Styling Notes (Avoiding Horizontal Scroll)

The app uses CSS grid heavily. To prevent accidental horizontal overflow:

- `min-width: 0` is applied to grid items (`.app-main`, `.panel`, `.workspace`, `.subpanel`)
- grid columns use `minmax(0, 1fr)` for flexible columns
- global `overflow-x: hidden` is applied on `body` and wrapper containers

These changes prevent the "scroll to the right to see draft" issue.

## 11. Key Frontend Work History (High-Level)

This is the condensed list of the major changes implemented so far.

- OAuth callback correctness:
  - auth callback now correctly hydrates session and routes back into app
  - connector callback now forwards `redirect_uri` to backend so backend redirects to UI
- Connection status semantics:
  - inactive is treated as "needs initial connect" (not "connected")
  - revoked/expired/error are treated as "needs reconnect"
- Rate-limit & API load reduction:
  - sticky endpoint mode selection to avoid repeated 404/405 probing
  - socket-driven pipeline status to reduce manual refresh/button spamming
- Revoked/expired UX:
  - explicit reconnect CTAs and sync guards
- Pipeline visibility:
  - top banner shows in-progress sync state
  - inbox shows triage/draft pending indicators and polls only when needed
- Draft UX:
  - optimistic `draft_pending` representation while generation runs
  - improved draft field normalization and enrichment for visibility
- Backend alignment updates:
  - new manual re-triage endpoint support (Re-classify)
  - draft generation changed to upsert semantics
  - taxonomy simplified to 3 categories (reply_needed/promotions/info)
  - added event name aliases (`draft:generated`, `triage_generated`, etc.)

## 12. Operational Notes

- Frontend dev server runs on its own port (typically Vite default `5173`).
- Backend CORS must allow the UI origin (or be permissive in dev).
- Socket.IO requires a valid `accessToken` and will show "Realtime unavailable" toast if disconnected.

