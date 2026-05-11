# API Contracts — Complete Reference

All endpoints are prefixed with `/api/v1`. All responses are JSON. All timestamps are ISO 8601 UTC.

---

## Standard Response Formats

### Success

Responses return data directly at the top level (not wrapped in a `data` envelope):

```json
{
  "threads": [...],
  "pagination": {                    // Only for list endpoints
    "limit": 20,
    "offset": 0,
    "count": 20
  }
}
```

Some endpoints use offset-based pagination (`limit` + `offset` + `count`) rather than page-based.

### Error

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable message",
    "details": { ... }              // Field-level errors, context
  }
}
```

### Standard HTTP codes used

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 204 | No content (successful delete) |
| 400 | Validation error |
| 401 | Not authenticated |
| 403 | Not authorized |
| 404 | Not found |
| 409 | Conflict (concurrency, duplicate) |
| 429 | Rate limited |
| 500 | Internal server error |

---

## Authentication Endpoints

### `GET /api/v1/auth/google`

Start Google OAuth login flow.

| | |
|---|---|
| Auth | Public |
| Rate limit | IP rate limit |
| Query params | `redirect_uri` (optional, frontend callback URL — must be in CORS_ORIGINS whitelist) |
| Response | 302 redirect to Google consent screen (scopes: profile, email) |

### `GET /api/v1/auth/google/callback`

Handle Google OAuth callback. Issues JWT tokens.

| | |
|---|---|
| Auth | Public (Passport handles Google verification) |
| Rate limit | IP rate limit |
| Query params | `code`, `state` (from Google) |

With `redirect_uri` in state: 302 redirect to frontend with `?accessToken=...&refreshToken=...` query params.

Without redirect_uri (Postman/testing fallback):
```json
{
  "message": "Google login successful",
  "user": {
    "id": "uuid",
    "email": "user@gmail.com",
    "name": "John Doe"
  },
  "accessToken": "jwt...",
  "refreshToken": "jwt..."
}
```

### `POST /api/v1/auth/register`

Traditional email/password registration.

| | |
|---|---|
| Auth | Public |
| Rate limit | IP rate limit |
| Body | `{ "email": "string", "password": "string", "name": "string" }` |
| Validation | Email format, password min 8 chars, name required |

```json
{
  "user": { "id": "uuid", "email": "...", "name": "..." },
  "accessToken": "jwt...",
  "refreshToken": "jwt..."
}
```

### `POST /api/v1/auth/login`

Traditional login.

| | |
|---|---|
| Auth | Public |
| Rate limit | IP rate limit |
| Body | `{ "email": "string", "password": "string" }` |

Response: Same format as register.

### `POST /api/v1/auth/refresh`

Refresh access token.

| | |
|---|---|
| Auth | Refresh token in body |
| Rate limit | IP rate limit |
| Body | `{ "refreshToken": "string" }` |

```json
{
  "accessToken": "jwt...",
  "refreshToken": "jwt..."
}
```

### `GET /api/v1/auth/me`

Get current authenticated user.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "id": "uuid",
  "email": "user@gmail.com",
  "name": "John Doe",
  "role": "user"
}
```

### `POST /api/v1/auth/logout`

Invalidate refresh token.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |
| Response | 204 |

---

## Connection Endpoints

### `GET /api/v1/connections`

List all connectors and user's connection status.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "connectors": [
    {
      "type": "gmail",
      "displayName": "Gmail",
      "category": "email",
      "description": "...",
      "connected": true,
      "isUsable": true,
      "status": "active",
      "lastSyncedAt": "2026-04-18T10:30:00Z",
      "lastSyncStatus": "success"
    }
  ]
}
```

### `GET /api/v1/connections/connect/:type`

Start OAuth flow for an external service (currently Gmail only).

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |
| Query params | `redirect_uri` (optional, for frontend callback after OAuth) |

```json
{
  "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?..."
}
```

### `GET /api/v1/connections/reconnect/:type`

Re-initiate OAuth for expired/revoked connection. Same behavior as `/connect/:type`.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

### `GET /api/v1/connections/callback`

Handle external service OAuth callback (browser redirect from Google).

| | |
|---|---|
| Auth | None (userId from signed `state` parameter) |
| Rate limit | IP rate limit |
| Query params | `code`, `state`, `scope`, `error` |

On success with `redirect_uri` in state: 302 redirect to frontend with `?gmail_connected=true&connectionId=uuid`.

On success without redirect_uri (Postman fallback):
```json
{
  "message": "Gmail connected successfully",
  "connectionId": "uuid",
  "status": "active",
  "syncQueued": true,
  "permissions": {
    "canRead": true,
    "canSend": true,
    "canModify": false
  }
}
```

The callback also:
- Verifies all required scopes were granted (returns error if missing)
- Bootstraps a default user profile on first connection
- Triggers initial Gmail sync automatically

### `POST /api/v1/connections/:type/sync`

Trigger manual inbox sync.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |
| Body | `{ "maxResults": 20 }` (optional) |

```json
{
  "message": "Sync job queued",
  "jobId": "gmail-sync-uuid",
  "connectionId": "uuid"
}
```

### `DELETE /api/v1/connections/:type`

Disconnect (revoke) an external service.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "message": "gmail disconnected"
}
```

---

## Thread Endpoints

All thread endpoints are scoped under `/api/v1/connections/:type/threads`.

### `GET /api/v1/connections/:type/threads`

List synced threads with triage and draft status.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |
| Query params | `limit` (default 20, max 100), `offset` (default 0), `category` (filter by triage classification) |

```json
{
  "threads": [
    {
      "id": "uuid",
      "externalThreadId": "gmail-thread-id",
      "subject": "Q3 Budget Review",
      "participants": [{"email": "boss@company.com", "name": "Jane"}],
      "messageCount": 4,
      "lastMessageAt": "2026-04-18T09:00:00Z",
      "syncStatus": "synced",
      "triage": {
        "classification": "reply_needed",
        "confidence": 0.92,
        "reasoning": "Direct question from sender"
      },
      "draft": {
        "status": "generated"
      }
    }
  ],
  "pagination": { "limit": 20, "offset": 0, "count": 20 }
}
```

### `GET /api/v1/connections/:type/threads/:id`

Thread detail with full message history.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "thread": {
    "id": "uuid",
    "subject": "Q3 Budget Review",
    "participants": [...],
    "messageCount": 4,
    "lastMessageAt": "2026-04-18T09:00:00Z"
  },
  "messages": [
    {
      "id": "uuid",
      "fromAddress": "boss@company.com",
      "toAddresses": ["user@gmail.com"],
      "ccAddresses": [],
      "subject": "Re: Q3 Budget Review",
      "bodyText": "Can you send the updated numbers?",
      "bodyHtml": "<p>Can you send...</p>",
      "receivedAt": "2026-04-18T09:00:00Z",
      "isSentByUser": false
    }
  ]
}
```

### `GET /api/v1/connections/:type/threads/:id/triage`

Get AI classification for a thread.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "id": "uuid",
  "classification": "reply_needed",
  "confidenceScore": 0.92,
  "reasoning": "Direct question from sender, user in To",
  "actionRequired": true,
  "urgencyScore": 0.8,
  "metadata": {...},
  "createdAt": "2026-04-18T09:01:00Z"
}
```

Returns `{ "status": "pending_or_missing" }` if not yet classified.

### `POST /api/v1/connections/:type/threads/:id/triage`

Trigger manual re-triage (deletes existing result and re-classifies).

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "message": "Re-triage triggered",
  "taskId": "celery-task-uuid",
  "threadId": "uuid",
  "correlationId": "manual-triage-uuid"
}
```

---

## Draft Endpoints

Draft operations are scoped under `/api/v1/connections/:type/threads/:id/draft`.

### `GET /api/v1/connections/:type/threads/:id/draft`

Get the latest AI-generated draft for a thread.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "id": "uuid",
  "status": "generated",
  "generatedContent": "AI-generated original...",
  "currentContent": "User-edited version (or same as generated)...",
  "version": 1,
  "generationMetadata": {
    "model": "gemini-2.0-flash",
    "input_tokens": 1200,
    "output_tokens": 350,
    "cost": 0.0004
  },
  "createdAt": "2026-04-18T09:05:00Z",
  "updatedAt": "2026-04-18T09:05:00Z"
}
```

Returns `{ "status": "not_generated" }` if no draft exists.

### `POST /api/v1/connections/:type/threads/:id/draft`

Trigger manual draft generation.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "message": "Manual draft generation triggered",
  "taskId": "celery-task-uuid",
  "threadId": "uuid",
  "correlationId": "manual-draft-uuid"
}
```

### `PUT /api/v1/connections/:type/threads/:id/draft`

Edit draft content.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |
| Body | `{ "content": "string" }` |

Returns 409 if draft is in `sent` or `approved` state.

```json
{
  "id": "uuid",
  "status": "edited",
  "version": 2,
  "currentContent": "Updated content...",
  "updatedAt": "2026-04-18T09:10:00Z"
}
```

Also syncs the updated content to the Gmail drafts folder if an external draft exists.

### `POST /api/v1/connections/:type/threads/:id/approve`

Approve draft for sending.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

Returns 409 if draft was already approved or sent.

```json
{
  "status": "approved",
  "message": "Draft approved and queued for sending",
  "jobId": "bullmq-job-id"
}
```

### `POST /api/v1/connections/:type/threads/:id/reject`

Reject draft.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

Returns 409 if draft was already sent.

```json
{
  "status": "rejected",
  "message": "Draft has been rejected"
}
```

Also deletes the Gmail draft from the user's drafts folder if one exists.

---

## Inbox Endpoint

### `GET /api/v1/inbox`

Unified inbox view across active connections (alternative to `/connections/:type/threads`).

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |
| Query params | `limit` (default 50, max 100), `offset` (default 0), `category` (filter by triage classification) |

```json
{
  "threads": [
    {
      "id": "uuid",
      "externalThreadId": "gmail-thread-id",
      "subject": "Q3 Budget Review",
      "participants": [{"email": "boss@company.com", "name": "Jane"}],
      "messageCount": 4,
      "lastMessageAt": "2026-04-18T09:00:00Z",
      "syncStatus": "synced",
      "triage": {
        "classification": "reply_needed",
        "confidence": 0.92,
        "reasoning": "Direct question from sender"
      },
      "draftStatus": "generated"
    }
  ],
  "pagination": { "limit": 50, "offset": 0, "count": 20 }
}
```

---

## Profile & Preferences Endpoints

### `GET /api/v1/profile`

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "exists": true,
  "profile": {
    "preferredTone": "professional",
    "personalizedProfile": "Write professionally and clearly...",
    "greetingStyle": {"formal": true, "common_phrases": ["Hello", "Hi"]},
    "closingStyle": {"formal": true, "common_phrases": ["Best regards", "Thanks"]},
    "signatureTemplate": "-- \nJohn Doe",
    "communicationNorms": {"sentence_length": "medium", "uses_bullet_points": false},
    "confidenceScore": "0.78",
    "profileVersion": 3,
    "lastCalibratedAt": "2026-04-15T00:00:00Z"
  }
}
```

Returns `{ "exists": false, "profile": null, "message": "..." }` if no profile exists.

### `PUT /api/v1/profile`

Update profile fields (partial update). Accepts both camelCase and snake_case field names.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |
| Body | Any subset: `{ "preferredTone": "string", "personalizedProfile": "string", "signatureTemplate": "string" }` |

```json
{
  "exists": true,
  "profile": { ... }
}
```

### `DELETE /api/v1/profile`

Reset the user's profile (forces re-generation on next sync).

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "message": "Profile reset. It will be re-generated on next sync."
}
```

### `GET /api/v1/preferences`

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "autoSync": {
    "enabled": false,
    "intervalHours": 24
  }
}
```

### `GET /api/v1/preferences/auto-sync`

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |

```json
{
  "enabled": false,
  "intervalHours": 24,
  "lastSyncAt": "2026-04-18T10:30:00Z",
  "gmailConnected": true
}
```

### `PUT /api/v1/preferences/auto-sync`

Enable/disable auto-sync with configurable interval.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |
| Body | `{ "enabled": true, "intervalHours": 24 }` |
| Validation | `enabled` must be boolean, `intervalHours` must be integer 1–168 |

When enabling, triggers an immediate sync. Requires an active Gmail connection.

```json
{
  "enabled": true,
  "intervalHours": 24,
  "message": "Auto-sync enabled. Emails sync every 24 hour(s). Syncing now."
}
```

---

## Usage & Billing Endpoints

### `GET /api/v1/usage`

Aggregated usage metrics for the authenticated user.

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |
| Query params | `period` — one of `7d`, `30d`, `90d`, `all` (default: `30d`) |

```json
{
  "period": {
    "label": "30d",
    "from": "2026-03-18T00:00:00.000Z",
    "to": "2026-04-18T10:00:00.000Z"
  },
  "summary": {
    "emailsSynced": 145,
    "emailsClassified": 130,
    "heuristicClassified": 45,
    "llmClassified": 85,
    "triageBreakdown": {
      "reply_needed": 42,
      "promotions": 38,
      "info": 45,
      "junk": 5
    },
    "draftsGenerated": 42,
    "draftsPending": 3,
    "draftsApproved": 30,
    "draftsSent": 28,
    "draftsRejected": 5,
    "emailsSent": 28,
    "llmCost": {
      "triageUsd": 0.012,
      "draftingUsd": 0.089,
      "totalUsd": 0.101
    },
    "tokens": {
      "triageInput": 45000,
      "triageOutput": 8500,
      "draftInput": 120000,
      "draftOutput": 35000,
      "totalInput": 165000,
      "totalOutput": 43500,
      "grandTotal": 208500
    }
  },
  "autoSync": {
    "enabled": false,
    "intervalHours": 24,
    "lastSyncAt": "2026-04-18T10:30:00Z"
  }
}
```

> **Note:** The implementation does not use a separate `usage_records` table for tracking. Instead, costs and tokens are computed directly from `triage_results.llm_metadata` and `drafts.generation_metadata` JSONB columns. This avoids double-writes while still providing accurate aggregation.

---

## History Endpoints

### `GET /api/v1/history/sends`

| | |
|---|---|
| Auth | JWT |
| Rate limit | User rate limit |
| Limit | 50 most recent |

```json
{
  "sends": [
    {
      "id": "uuid",
      "status": "delivered",
      "queuedAt": "2026-04-18T09:15:00Z",
      "completedAt": "2026-04-18T09:15:03Z",
      "errorMessage": null,
      "draftId": "uuid",
      "content": "Hi Jane, here are the updated numbers...",
      "subject": "Re: Q3 Budget Review",
      "externalThreadId": "gmail-thread-id"
    }
  ]
}
```

---

## Admin Endpoints

### `GET /api/v1/admin/health`

Deep health check — verifies DB and Redis connectivity.

| | |
|---|---|
| Auth | Public |

```json
{
  "status": "healthy",
  "uptime": 86400,
  "components": {
    "database": { "status": "up", "latencyMs": 3 },
    "redis": { "status": "up", "latencyMs": 1 }
  }
}
```

Returns 503 with `"status": "degraded"` if any component is down.

### `GET /api/v1/admin/ping`

Lightweight liveness probe — no external dependency checks.

| | |
|---|---|
| Auth | Public |

```json
{
  "status": "ok",
  "timestamp": "2026-04-18T10:30:00.000Z"
}
```

> **Note:** The documented admin endpoints for metrics, user listing, and global usage are not yet implemented. The health endpoint is public (no API key required) in the current implementation.

---

## WebSocket Events

Connect: Socket.IO at the gateway's HTTP server. Authentication via JWT in handshake.

Events are published from the Python AI Engine via Redis pub/sub (`draftly:events` channel) and forwarded by the Node gateway to the specific user's socket room.

| Event | Direction | Payload |
|-------|-----------|---------|
| `sync:started` | Server → Client | `{ connectionId, correlationId }` |
| `sync:completed` | Server → Client | `{ connectionId, correlationId, newThreads, updatedThreads }` |
| `sync:failed` | Server → Client | `{ connectionId, correlationId, error }` |
| `triage:started` | Server → Client | `{ userId, threadId, correlationId }` |
| `triage:completed` | Server → Client | `{ userId, threadId, correlationId, classification, confidence, reasoning }` |
| `draft:ready` | Server → Client | `{ userId, draftId, threadId }` |
| `draft:failed` | Server → Client | `{ userId, threadId, error }` |
| `profile:initialized` | Server → Client | `{ userId, preferredTone, signatureTemplate, personalizedProfile }` |
| `profile:updated` | Server → Client | `{ userId }` |

### Implementation Notes

- The gateway uses `emitToUser(userId, event, data)` to target specific users
- Redis pub/sub channel: `draftly:events`
- Events are fire-and-forget — if the user is offline, they'll see updated state on next API call
- The frontend `useRealtimeEvents` hook and `PipelineStatusContext` consume these events
