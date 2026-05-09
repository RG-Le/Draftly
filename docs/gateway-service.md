# Gateway Service (Node.js) — Detailed Design

## Role

The gateway is the only service that faces users and external APIs. It owns:
- All HTTP/WebSocket endpoints
- Authentication and authorization
- Gmail API communication (fetch + send)
- Token encryption and lifecycle
- Rate limiting
- Send dispatch (idempotent)
- Billing tracking
- Scheduled sync orchestration

It does **not** run any AI/LLM logic. That's the AI Engine's job.

---

## Design Decisions

| Decision | Choice | Why | Risk |
|----------|--------|-----|------|
| Express 5 over Fastify | Express | Richer middleware ecosystem (passport, helmet, express-rate-limit). More hiring candidates know it. Fastify is ~2x faster but Express handles 300 concurrent easily. | If traffic exceeds 10k concurrent, reconsider Fastify or Koa. |
| Knex.js over Prisma/TypeORM | Knex | Full SQL control. Clean migration system. No magic — you write the queries. Prisma's query engine adds a binary and abstraction we don't need. TypeORM's query builder has known edge cases. | Knex doesn't generate types from schema — we define our own TS interfaces. |
| BullMQ over pg-boss | BullMQ | Redis-backed is faster for high-throughput job processing. BullMQ supports rate limiting, priorities, repeatable jobs natively. pg-boss (Postgres-backed) adds write pressure to the primary DB. | Redis is an additional infra component. If Redis goes down, all queues stop. Mitigation: Redis persistence (AOF). |
| Pino over Winston | Pino | 5x faster. At 300 concurrent users, logger performance matters. Structured JSON output works with any log aggregator. | Pino's ecosystem is smaller than Winston's. No built-in file transport (use process-level redirection). |
| Zod over Joi | Zod | TypeScript-native. Infers types from schemas (no double definition). Better error messages. | Joi has more battle-testing in production Node.js apps. Zod is newer but stable enough. |

---

## Internal Structure

```
gateway/src/
├── index.ts                          # Starts Express + BullMQ workers
├── config/                           # Environment parsing (Zod validated)
│
├── domain/                           # Pure business logic, zero dependencies
│   ├── entities/                     # User, Draft, Thread, SendAttempt, etc.
│   ├── value-objects/                # DraftStatus (state machine), IdempotencyKey
│   └── errors/                       # ConcurrencyConflictError, DuplicateSendError
│
├── application/                      # Use cases — orchestration logic
│   ├── auth/                         # GoogleLoginUseCase, RegisterUseCase
│   ├── connections/                  # InitiateConnectionUseCase, HandleOAuthCallback
│   ├── inbox/                        # SyncInboxUseCase, GetThreadsUseCase
│   ├── drafts/                       # EditDraft, ApproveDraft, RejectDraft
│   ├── send/                         # SendReplyUseCase (idempotent)
│   ├── billing/                      # GetUsageSummary, RecordUsage
│   └── profile/                      # GetProfile, UpdatePreferences
│
├── infrastructure/                   # Framework + external implementations
│   ├── http/                         # Express server, routes, middleware, validators
│   ├── websocket/                    # Socket.IO + Redis pub/sub listener
│   ├── database/                     # Knex instance, migrations, repositories
│   ├── connectors/                   # ConnectorRegistry, Gmail services
│   ├── encryption/                   # AES-256-GCM service
│   ├── queue/                        # BullMQ manager, CeleryBridge, job handlers
│   └── metrics/                      # Prometheus client
│
└── shared/                           # Logger, utils, pagination
```

### Layer Rules
- **Domain** imports nothing from other layers. No `express`, no `knex`, no `redis`.
- **Application** imports from Domain only. Receives repositories/services via constructor injection.
- **Infrastructure** imports from Application and Domain. Implements the actual I/O.
- **Shared** is used by all layers (logger, utils).

This isn't pedantic — it means you can unit test any Use Case by injecting a mock repository. No database, no Redis, no network.

---

## Key Components

### Connector Registry

Not an abstract factory. A simple Map that tracks what external services are configured and healthy.

```typescript
class ConnectorRegistry {
  private connectors = new Map<string, ConnectorConfig>();

  register(name: string, config: ConnectorConfig): void;
  get(name: string): ConnectorConfig;
  isAvailable(name: string): boolean;
  healthCheckAll(): Promise<Map<string, HealthStatus>>;
}

interface ConnectorConfig {
  name: string;                    // 'gmail', 'google-calendar'
  authType: 'oauth2' | 'api-key';
  scopes?: string[];               // OAuth scopes needed
  quotaLimits?: QuotaConfig;
}
```

Why not a full adapter interface: Because `GmailSyncService.fetchInbox()` is always Gmail-specific. We don't need `IEmailAdapter.fetchInbox()` — there's no second email provider to swap in capstone scope. The registry exists for health checks, feature flags, and future connector discovery.

### Gmail Services

Three separate services, not one monolith:

| Service | Purpose | Called By |
|---------|---------|-----------|
| `GmailOAuthService` | OAuth flow, token exchange, token refresh | Auth routes, token refresh job |
| `GmailSyncService` | Fetch inbox, fetch threads, normalize messages | Sync worker |
| `GmailSendService` | Send threaded reply via Gmail API | Send worker |

### CeleryBridge

Node.js doesn't run Celery. It writes Celery-compatible job messages directly to Redis using Celery's v2 message protocol.

```typescript
class CeleryBridge {
  async enqueueTask(taskName: string, kwargs: Record<string, any>, queue: string): Promise<string>;
}
```

This avoids any synchronous HTTP dependency between Node and Python. Node writes to Redis, Python Celery workers consume from Redis. If Python is down, jobs queue safely.

### BullMQ Workers (Node-side)

| Worker | Queue | Concurrency | Purpose |
|--------|-------|-------------|---------|
| SyncWorker | `gmail-sync-queue` | 10 | Fetches emails from Gmail, stores in DB, enqueues triage |
| SendWorker | `gmail-send-queue` | 5 | Dispatches approved replies via Gmail API |
| ScheduledSync | `sync-scheduler` | 1 (repeatable) | Triggers sync for active connections every 5 min |
| TokenRefresh | `token-refresh-queue` | 3 | Proactively refreshes expiring OAuth tokens |

### WebSocket Manager

Listens on Redis pub/sub channels for events from Python workers. Forwards to the correct user's WebSocket room.

```
Python worker → Redis pub/sub (channel: "events") → Node WSManager → Socket.IO room (user:{userId})
```

Events: `sync:complete`, `triage:complete`, `draft:ready`, `draft:failed`, `send:success`, `send:failed`, `connection:alert`.

---

## Error Handling Strategy

| Error Type | HTTP Code | Action |
|-----------|-----------|--------|
| Validation failure | 400 | Return field-level errors (Zod) |
| Unauthorized | 401 | Return generic "Invalid credentials" |
| Forbidden | 403 | Return "Insufficient permissions" |
| Not found | 404 | Return "Resource not found" |
| Concurrency conflict (version mismatch) | 409 | Return "Draft was modified, please refresh" |
| Duplicate send | 409 | Return "This draft was already sent" |
| Rate limited | 429 | Return `Retry-After` header |
| Gmail API error (transient) | — | Retry in worker with exponential backoff |
| Gmail API error (permanent) | — | Mark job failed, notify user via WebSocket |
| Internal error | 500 | Log full error, return generic message to client |

All errors are structured:

```json
{
  "error": {
    "code": "CONCURRENCY_CONFLICT",
    "message": "Draft was modified by another request. Please refresh.",
    "details": { "currentVersion": 3, "expectedVersion": 2 }
  }
}
```

---

## Middleware Stack (order matters)

```typescript
app.use(correlationMiddleware);     // 1. Generate/propagate correlation ID
app.use(requestLoggerMiddleware);   // 2. Log every request (with correlation ID)
app.use(helmet());                  // 3. Security headers
app.use(cors(corsOptions));         // 4. CORS whitelist
app.use(ipRateLimiter);            // 5. Per-IP rate limit (200/min)
app.use(express.json({ limit: '1mb' }));  // 6. Body parsing with size limit
// Auth middleware is applied per-route group, not globally
// Endpoint-specific rate limiters are applied per-route
```

---

## Implementation Priority

1. Express server + health endpoint
2. Config (Zod from .env)
3. Database connection (Knex + PgBouncer)
4. Encryption service
5. Auth (Google OAuth + JWT + traditional)
6. Rate limiting (multi-layer)
7. Connector registry + Gmail OAuth
8. Sync worker + Gmail sync
9. CeleryBridge (enqueue to Python)
10. Draft CRUD + approve/reject
11. Send worker (idempotent)
12. WebSocket (Redis pub/sub listener)
13. Usage tracking
14. Prometheus metrics
