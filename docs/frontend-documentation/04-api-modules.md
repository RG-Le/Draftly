# API Modules (`src/api/*`)

All networking funnels through **`lib/http.ts` → `apiRequest`**, unless a module uses raw **`fetch`** for a special case (e.g. `getMeWithToken` with a fresh access token).

## Environment

- **`VITE_API_BASE_URL`** — trimmed of trailing slashes; default `http://localhost:3000`.
- Exported getter: **`getApiBaseUrl()`** — share with Socket.IO client.

## `lib/http.ts` behavior

| Feature | Behavior |
|---------|----------|
| Auth headers | Bearer `getAccessToken()` when `auth: true` (default) |
| `401` recovery | Calls **`POST /api/v1/auth/refresh`** with refresh token → updates storage via `patchStoredSession` → **one retry** of original request (`retryOnAuthError: false` on recursion) |
| Error shape | Parses JSON envelope `{ error: { code, message, details } }` → throws **`ApiError`** |
| SUCCESS shape | Supports optional `{ data: T }` unwrapping; otherwise returns raw parsed body |

Agents adding new centralized behavior (tracing headers, pagination metadata) should do it once in **`apiRequest`** rather than per module.

---

## Module reference

### `api/auth.ts`

| Function | Method & path |
|----------|----------------|
| `getGoogleAuthUrl()` | Builds URL to **`GET /api/v1/auth/google`** with `redirect_uri` = current origin + `/auth/callback` |
| `loginLocal` | `POST /api/v1/auth/login` (`auth: false`) |
| `registerLocal` | `POST /api/v1/auth/register` (`auth: false`) |
| `completeGoogleCallback` | `GET /api/v1/auth/google/callback` |
| `getMe` | `GET /api/v1/auth/me` |
| `getMeWithToken` | raw **`fetch`** with explicit Bearer |
| `logout` | `POST /api/v1/auth/logout` |

Normalization: **`normalizeAuthPayload`** accepts either `{ user, accessToken, refreshToken }` or nested `tokens.{accessToken,refreshToken}` — useful if gateway response shape differs slightly.

---

### `api/connections.ts`

Stateful **API shape detection**:

- Tracks **`connectionsApiMode`**: prefers **modern** `POST /api/v1/connections/initiate`; on `404`/`405` falls back to **legacy** **`GET /api/v1/connections/connect/gmail`** (`startGmailConnection`).
- Tracks Gmail-specific reconnect path: **`GET /api/v1/connections/reconnect/gmail`** with fallback back to legacy connect URL.

Important exports:

| Function | Notes |
|----------|-------|
| `listConnections()` | Parses `payload.connectors` **or** `.connections` **or** `.data.connectors` arrays |
| `syncInbox()` | Prefers **`POST /api/v1/inbox/sync`**, fallback **`POST /api/v1/connections/gmail/sync`** |
| `disconnectConnection(connectionId?, connectorType?)` | Tries **`DELETE /api/v1/connections/:id`** first, fallback **`DELETE /api/v1/connections/:connectorType`** |
| `completeConnectionCallback` | `GET /api/v1/connections/callback`, **`auth: false`** (browser redirect hasn’t populated SPA token in some setups — module forces unauthenticated GET) |

Helper predicates: **`getPrimaryGmailConnection`**, **`isConnectionActive`**, **`needsReconnect`**, **`needsInitialConnection`**.

Agents: when gateway stabilizes on one REST contract, **delete dead branches here** for clarity — but coordinate with QA.

---

### `api/inbox.ts`

Stateful **`inboxApiMode`** and **`inboxModernRouteMode`**.

Threads:

- Prefer **`GET /api/v1/inbox`** (`inboxModernRouteMode: 'root'`) or **`GET /api/v1/inbox/threads`** (`'threads'`).
- Fallback **`GET /api/v1/connections/gmail/threads`** with offset pagination.

Detail:

- Modern: **`GET /api/v1/inbox/threads/:id`** aggregated payload `{ thread, messages, triage, draft }`.
- Legacy: three parallel REST calls merged client-side `{ thread+triage+triage+triage drafts }`.

Mutations (**dual-route**):

- `generateDraftForThread`: tries **`POST /api/v1/drafts/:id/regenerate`** if `draftId` provided, fallback **`POST /api/v1/connections/gmail/threads/:id/draft`**.
- `editDraft`, `approveDraft`, `rejectDraft`: similar **preferred modern + legacy** branching.

Normalization handles snake_case ↔ camelCase and maps draft status **`edited` → `draft_edited`** in UI summaries.

---

### `api/drafts.ts`

Preferred **`GET /api/v1/drafts`**; if missing (`404`/`405`), derives list by iterating threads + **`getThreadDetail`** (slow fallback).

---

### `api/profile.ts`

`GET|PUT /api/v1/profile`, `GET|PUT /api/v1/preferences` — returns **empty / null gracefully** when backend lacks routes.

---

### `api/usage.ts` & `api/history.ts`

- **`/api/v1/usage/summary`, `/api/v1/usage`**
- **`/api/v1/history/sends`**

Graceful degrade to empty payloads on `404`/`405` for stub gateways.
