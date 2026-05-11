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
├── index.ts                          # Starts Express + BullMQ workers + WebSocket
├── config/
│   └── index.ts                      # Zod-validated environment parsing
│
├── domain/                           # Business logic and entities
│   ├── entities/
│   │   └── index.ts                  # User, UserConnection, EmailThread, EmailMessage, Draft, etc.
│   ├── errors/
│   │   └── index.ts                  # ValidationError, NotFoundError, AuthenticationError, etc.
│   ├── auth/
│   │   └── token.service.ts          # JWT token creation and verification (RS256)
│   ├── connectors/
│   │   ├── connection.repository.ts  # UserConnection CRUD
│   │   ├── email.repository.ts       # Thread/message/triage/draft queries
│   │   ├── gmail.adapter.ts          # Gmail API sync logic
│   │   └── registry.ts              # ConnectorRegistry (enabled connectors)
│   └── users/
│       └── repository.ts             # User CRUD
│
├── infrastructure/
│   ├── http/
│   │   ├── app.ts                    # Express app setup, middleware, route mounting
│   │   ├── routes/
│   │   │   ├── auth.ts              # Google OAuth + local auth + JWT refresh
│   │   │   ├── connections.ts       # Gmail OAuth, sync, threads, drafts, approve/reject
│   │   │   ├── health.ts           # Health check endpoint
│   │   │   ├── history.ts          # Send history
│   │   │   ├── inbox.ts            # Unified inbox view
│   │   │   ├── preferences.ts      # User preferences CRUD
│   │   │   ├── profile.ts          # Communication profile GET/PUT/DELETE
│   │   │   └── usage.ts            # Usage metrics and cost tracking
│   │   └── middleware/
│   │       ├── auth.ts              # JWT verification (requireAuth)
│   │       ├── correlation.ts       # Correlation ID generation
│   │       ├── error-handler.ts     # Global error handler
│   │       ├── rate-limiter.ts      # IP + user rate limiting (Redis-backed)
│   │       ├── request-logger.ts    # Request logging
│   │       └── index.ts            # Middleware exports
│   ├── database/
│   │   └── connection.ts            # Knex.js instance + migrations
│   ├── encryption/
│   │   └── index.ts                 # AES-256-GCM encrypt/decrypt
│   ├── redis/
│   │   └── connection.ts            # ioredis connection
│   ├── socket/
│   │   └── websocket.ts            # Socket.IO + Redis pub/sub listener
│   └── workers/
│       ├── auto-sync.service.ts     # Scheduled auto-sync service
│       ├── celery-bridge.ts         # Celery v2 protocol message builder
│       ├── draft-sync.worker.ts     # Sync drafts to Gmail drafts folder
│       ├── gmail-sync.worker.ts     # BullMQ worker for Gmail inbox sync
│       └── send-reply.worker.ts     # BullMQ worker for sending approved replies
│
└── shared/
    └── logger.ts                     # Pino logger configuration
```

### Layer Rules
- **Domain** contains entities, repositories, and business logic. No Express or infrastructure dependencies.
- **Infrastructure** implements I/O: HTTP routes, database, Redis, workers, encryption.
- **Shared** is used by all layers (logger).

> **Note:** The implementation does not have a separate `application/` use-case layer. Business logic is implemented directly in route handlers and workers, with repositories handling data access.

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
| GmailSyncWorker | `gmail-sync` | 5 | Fetches emails from Gmail, stores in DB, dispatches batch triage + profile build |
| SendReplyWorker | `gmail-send` | 5 | Dispatches approved replies via Gmail API |
| DraftSyncWorker | `draft-sync` | — | Syncs draft content to Gmail drafts folder (create/update/delete) |
| AutoSyncService | — | — | Scheduled auto-sync for active connections |

The Gmail sync worker also handles:
- Job deduplication by connectionId (only one active sync per connection)
- Automatic batch triage dispatch for unclassified threads after sync
- Profile build dispatch if user profile hasn't been calibrated yet

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
app.use(express.json({ limit: '1mb' }));  // 5. Body parsing with size limit
// Auth + rate limiting middleware applied per-route, not globally
// ipRateLimitMiddleware: Per-IP (configurable, default 200/min)
// userRateLimitMiddleware: Per-user (configurable, default 100/min)
```

Rate limiting uses `rate-limiter-flexible` with Redis backend (not `express-rate-limit`). Limits are configurable via environment variables:
- `RATE_LIMIT_IP_PER_MIN` (default: 200)
- `RATE_LIMIT_USER_PER_MIN` (default: 100)

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
