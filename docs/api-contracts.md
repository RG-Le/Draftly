# API Contracts — Complete Reference

All endpoints are prefixed with `/api/v1`. All responses are JSON. All timestamps are ISO 8601 UTC.

---

## Standard Response Formats

### Success

```json
{
  "data": { ... },
  "pagination": {                    // Only for list endpoints
    "page": 1,
    "limit": 20,
    "total": 145,
    "totalPages": 8
  }
}
```

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
| Rate limit | 10/min/IP |
| Query params | `redirect_uri` (optional, for frontend callback) |
| Response | 302 redirect to Google consent screen |

### `GET /api/v1/auth/google/callback`

Handle Google OAuth callback.

| | |
|---|---|
| Auth | Public |
| Rate limit | 10/min/IP |
| Query params | `code`, `state` (CSRF token) |
| Response | `201` on new user, `200` on existing |

```json
{
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@gmail.com",
      "name": "John Doe",
      "role": "user",
      "authProvider": "google"
    },
    "tokens": {
      "accessToken": "jwt...",
      "refreshToken": "jwt...",
      "expiresIn": 900
    }
  }
}
```

### `POST /api/v1/auth/register`

Traditional email/password registration.

| | |
|---|---|
| Auth | Public |
| Rate limit | 5/min/IP |
| Body | `{ "email": "string", "password": "string", "name": "string" }` |
| Validation | Email format, password min 8 chars, name required |

Response: Same format as Google callback.

### `POST /api/v1/auth/login`

Traditional login.

| | |
|---|---|
| Auth | Public |
| Rate limit | 10/min/IP |
| Body | `{ "email": "string", "password": "string" }` |

Response: Same format as Google callback.

### `POST /api/v1/auth/refresh`

Refresh access token.

| | |
|---|---|
| Auth | Refresh token in body |
| Rate limit | 30/min/user |
| Body | `{ "refreshToken": "string" }` |

```json
{
  "data": {
    "accessToken": "jwt...",
    "expiresIn": 900
  }
}
```

### `POST /api/v1/auth/logout`

Invalidate refresh token.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 10/min/user |
| Response | 204 |

---

## Connection Endpoints

### `POST /api/v1/connections/initiate`

Start OAuth flow for an external service.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 5/min/user |
| Body | `{ "connectorType": "gmail" }` |

```json
{
  "data": {
    "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?...",
    "state": "csrf-token"
  }
}
```

### `GET /api/v1/connections/callback`

Handle external service OAuth callback.

| | |
|---|---|
| Auth | JWT (via state parameter) |
| Rate limit | 5/min/user |
| Query params | `code`, `state`, `connector` |

```json
{
  "data": {
    "connection": {
      "id": "uuid",
      "connectorType": "gmail",
      "status": "active",
      "connectorMetadata": {
        "email": "user@gmail.com",
        "scopesGranted": ["gmail.readonly", "gmail.send"]
      },
      "createdAt": "2026-04-18T10:00:00Z"
    }
  }
}
```

### `GET /api/v1/connections`

List user's connections.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 60/min/user |

```json
{
  "data": {
    "connections": [
      {
        "id": "uuid",
        "connectorType": "gmail",
        "status": "active",
        "lastSyncedAt": "2026-04-18T10:30:00Z",
        "lastSyncStatus": "success",
        "createdAt": "2026-04-18T10:00:00Z"
      }
    ]
  }
}
```

### `DELETE /api/v1/connections/:id`

Disconnect an external service. Revokes tokens.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 5/min/user |
| Response | 204 |

### `POST /api/v1/connections/:id/reconnect`

Re-initiate OAuth for expired/revoked connection.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 5/min/user |

Response: Same as `POST /connections/initiate`.

---

## Inbox Endpoints

### `POST /api/v1/inbox/sync`

Trigger manual inbox sync.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 5/min/user |
| Body | `{ "connectionId": "uuid" }` (optional — syncs all if omitted) |

```json
{
  "data": {
    "jobId": "uuid",
    "message": "Sync started"
  }
}
```

### `GET /api/v1/inbox/threads`

List threads with triage status.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 60/min/user |
| Query params | `page` (default 1), `limit` (default 20, max 50), `classification` (filter), `sort` (default `-lastMessageAt`) |

```json
{
  "data": {
    "threads": [
      {
        "id": "uuid",
        "subject": "Q3 Budget Review",
        "participants": [{"email": "boss@company.com", "name": "Jane"}],
        "messageCount": 4,
        "lastMessageAt": "2026-04-18T09:00:00Z",
        "syncStatus": "synced",
        "triage": {
          "classification": "reply_needed",
          "confidence": 0.92,
          "method": "heuristic"
        },
        "latestDraft": {
          "id": "uuid",
          "status": "draft_ready"
        }
      }
    ]
  },
  "pagination": { "page": 1, "limit": 20, "total": 85, "totalPages": 5 }
}
```

### `GET /api/v1/inbox/threads/:id`

Thread detail with messages and triage.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 60/min/user |

```json
{
  "data": {
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
        "from": "boss@company.com",
        "to": ["user@gmail.com"],
        "cc": [],
        "subject": "Re: Q3 Budget Review",
        "bodyText": "Can you send the updated numbers?",
        "receivedAt": "2026-04-18T09:00:00Z",
        "isSentByUser": false
      }
    ],
    "triage": {
      "classification": "reply_needed",
      "confidence": 0.92,
      "method": "heuristic",
      "reasoning": "Direct question from sender, user in To"
    }
  }
}
```

---

## Draft Endpoints

### `GET /api/v1/drafts`

List drafts.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 60/min/user |
| Query params | `status` (filter), `page`, `limit` |

```json
{
  "data": {
    "drafts": [
      {
        "id": "uuid",
        "threadId": "uuid",
        "threadSubject": "Q3 Budget Review",
        "status": "draft_ready",
        "currentContent": "Hi Jane, here are the updated numbers...",
        "version": 1,
        "createdAt": "2026-04-18T09:05:00Z",
        "updatedAt": "2026-04-18T09:05:00Z"
      }
    ]
  },
  "pagination": { ... }
}
```

### `GET /api/v1/drafts/:id`

Draft detail with thread context and action history.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 60/min/user |

```json
{
  "data": {
    "draft": {
      "id": "uuid",
      "threadId": "uuid",
      "generatedContent": "AI-generated original...",
      "currentContent": "User-edited version...",
      "status": "draft_edited",
      "version": 2,
      "generationMetadata": {
        "model": "gemini-2.0-flash",
        "inputTokens": 1200,
        "outputTokens": 350,
        "estimatedCost": 0.0004
      },
      "createdAt": "2026-04-18T09:05:00Z"
    },
    "thread": { ... },
    "actions": [
      {
        "actionType": "edit",
        "createdAt": "2026-04-18T09:10:00Z"
      }
    ]
  }
}
```

### `PUT /api/v1/drafts/:id`

Edit draft content.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 30/min/user |
| Body | `{ "content": "string", "expectedVersion": 2 }` |

Returns 409 if version mismatch (another edit happened since you loaded).

```json
{
  "data": {
    "draft": {
      "id": "uuid",
      "currentContent": "Updated content...",
      "status": "draft_edited",
      "version": 3
    }
  }
}
```

### `POST /api/v1/drafts/:id/approve`

Approve draft for sending.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 10/min/user |
| Body | `{ "expectedVersion": 3 }` |

Returns 409 if draft was modified since user loaded it.
Returns 409 if draft was already approved and sent.

```json
{
  "data": {
    "draft": {
      "id": "uuid",
      "status": "approved",
      "idempotencyKey": "send:uuid:v3"
    },
    "sendAttempt": {
      "id": "uuid",
      "status": "pending",
      "queuedAt": "2026-04-18T09:15:00Z"
    }
  }
}
```

### `POST /api/v1/drafts/:id/reject`

Reject draft.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 10/min/user |
| Body | `{ "reason": "string" }` (optional) |

```json
{
  "data": {
    "draft": {
      "id": "uuid",
      "status": "rejected"
    }
  }
}
```

### `POST /api/v1/drafts/:id/regenerate`

Request new AI draft for the same thread.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 5/min/user |
| Body | `{ "instructions": "Make it more formal" }` (optional hint) |

```json
{
  "data": {
    "draft": {
      "id": "uuid",
      "status": "draft_pending"
    },
    "jobId": "celery-task-uuid"
  }
}
```

---

## Profile & Preferences Endpoints

### `GET /api/v1/profile`

| | |
|---|---|
| Auth | JWT |
| Rate limit | 30/min/user |

```json
{
  "data": {
    "profile": {
      "greetingStyle": {"formal": "Dear", "casual": "Hi"},
      "closingStyle": {"default": "Best regards"},
      "signatureTemplate": "-- \nJohn Doe\nSenior Engineer",
      "preferredTone": "professional",
      "communicationNorms": {...},
      "profileVersion": 3,
      "confidenceScore": 0.78,
      "lastCalibratedAt": "2026-04-15T00:00:00Z"
    }
  }
}
```

### `PUT /api/v1/profile`

Update profile fields (partial update).

| | |
|---|---|
| Auth | JWT |
| Rate limit | 10/min/user |
| Body | Any subset of profile fields |

### `GET /api/v1/preferences`

| Auth | JWT |
| Rate limit | 30/min/user |

```json
{
  "data": {
    "preferences": [
      { "key": "defaultTone", "value": "professional" },
      { "key": "autoSync", "value": true },
      { "key": "syncInterval", "value": 5 }
    ]
  }
}
```

### `PUT /api/v1/preferences`

| | |
|---|---|
| Auth | JWT |
| Rate limit | 10/min/user |
| Body | `{ "key": "string", "value": any }` |

---

## Usage & Billing Endpoints

### `GET /api/v1/usage`

Detailed usage records.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 30/min/user |
| Query params | `from` (date), `to` (date), `resourceType` (filter), `page`, `limit` |

```json
{
  "data": {
    "records": [
      {
        "resourceType": "llm_output_tokens",
        "resourceDetail": "gemini-2.0-flash",
        "quantity": 350,
        "estimatedCostUsd": 0.0004,
        "usageDate": "2026-04-18",
        "correlationId": "corr-uuid"
      }
    ]
  },
  "pagination": { ... }
}
```

### `GET /api/v1/usage/summary`

Aggregated usage summary.

| | |
|---|---|
| Auth | JWT |
| Rate limit | 10/min/user |
| Query params | `month` (YYYY-MM) |

```json
{
  "data": {
    "month": "2026-04",
    "totalEstimatedCost": 2.47,
    "currency": "USD",
    "breakdown": {
      "llm": {
        "inputTokens": 187420,
        "outputTokens": 42800,
        "totalRequests": 156,
        "estimatedCost": 2.31,
        "byModel": {
          "gemini-2.0-flash": { "requests": 140, "cost": 1.89 },
          "gemini-1.5-flash": { "requests": 16, "cost": 0.42 }
        }
      },
      "gmail": {
        "syncCalls": 640,
        "sendCalls": 89
      },
      "draftsGenerated": 134,
      "emailsSent": 89
    }
  }
}
```

---

## History Endpoints

### `GET /api/v1/history/sends`

| | |
|---|---|
| Auth | JWT |
| Rate limit | 30/min/user |
| Query params | `page`, `limit`, `from`, `to` |

```json
{
  "data": {
    "sends": [
      {
        "id": "uuid",
        "draftId": "uuid",
        "threadSubject": "Q3 Budget Review",
        "status": "sent",
        "externalMessageId": "gmail-msg-id",
        "attemptNumber": 1,
        "queuedAt": "2026-04-18T09:15:00Z",
        "completedAt": "2026-04-18T09:15:03Z"
      }
    ]
  },
  "pagination": { ... }
}
```

### `GET /api/v1/history/actions`

| | |
|---|---|
| Auth | JWT |
| Rate limit | 30/min/user |
| Query params | `page`, `limit`, `entityType`, `actionType` |

---

## Admin Endpoints

### `GET /api/v1/admin/health`

| | |
|---|---|
| Auth | API Key |

```json
{
  "status": "healthy",
  "uptime": 86400,
  "components": {
    "database": { "status": "up", "latencyMs": 3 },
    "redis": { "status": "up", "latencyMs": 1 },
    "aiEngine": { "status": "up", "latencyMs": 15 },
    "gmail": { "status": "up" }
  },
  "queues": {
    "gmail-sync-queue": { "waiting": 5, "active": 3, "failed": 0 },
    "gmail-send-queue": { "waiting": 0, "active": 1, "failed": 0 },
    "triage-queue": { "waiting": 12, "active": 8, "failed": 0 },
    "draft-queue": { "waiting": 4, "active": 3, "failed": 1 },
    "profile-queue": { "waiting": 0, "active": 0, "failed": 0 }
  }
}
```

### `GET /api/v1/admin/metrics`

Prometheus text format. Scraped by monitoring infrastructure.

| Auth | API Key |

### `GET /api/v1/admin/users`

| | |
|---|---|
| Auth | Admin JWT |
| Rate limit | 10/min |

### `GET /api/v1/admin/usage/global`

| | |
|---|---|
| Auth | Admin JWT |
| Rate limit | 10/min |

---

## WebSocket Events

Connect: `wss://host/ws` with JWT in handshake auth.

| Event | Direction | Payload |
|-------|-----------|---------|
| `sync:started` | Server → Client | `{ connectionId, jobId }` |
| `sync:progress` | Server → Client | `{ connectionId, processed, total }` |
| `sync:completed` | Server → Client | `{ connectionId, newThreads, updatedThreads }` |
| `sync:failed` | Server → Client | `{ connectionId, error }` |
| `triage:completed` | Server → Client | `{ threadId, classification, confidence }` |
| `draft:ready` | Server → Client | `{ draftId, threadId, subject }` |
| `draft:failed` | Server → Client | `{ draftId, threadId, error }` |
| `send:queued` | Server → Client | `{ draftId, attemptId }` |
| `send:success` | Server → Client | `{ draftId, externalMessageId }` |
| `send:failed` | Server → Client | `{ draftId, error, retryable }` |
| `connection:expiring` | Server → Client | `{ connectionId, expiresAt }` |
| `connection:expired` | Server → Client | `{ connectionId }` |
