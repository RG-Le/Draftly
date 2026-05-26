# GCP Architecture Overview

## System Topology

Draftly runs as a dual-service application on Google Cloud Platform using Cloud Run (serverless containers) as the compute platform.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          PUBLIC INTERNET                                  │
└──────────────┬──────────────────────────────────┬───────────────────────┘
               │                                  │
               ▼                                  ▼
┌──────────────────────────┐       ┌──────────────────────────┐
│   draftly-gateway        │       │   draftly-frontend       │
│   Cloud Run (public)     │       │   Cloud Run (public)     │
│   Port 3000              │       │   Port 3001              │
│   1 vCPU / 512 MB        │       │   1 vCPU / 256 MB        │
│   Min 1 / Max 5          │       │   Min 0 / Max 3          │
└──────────┬───────────────┘       └──────────────────────────┘
           │
           │ (internal only via VPC)
           ▼
┌──────────────────────────┐
│   draftly-ai-worker      │
│   Cloud Run (internal)   │
│   Celery Worker          │
│   2 vCPU / 1 GB          │
│   Min 1 / Max 3          │
└──────────┬───────────────┘
           │
           │ VPC Connector (private networking)
           ▼
┌──────────────────────────────────────────────────────────────┐
│                    PRIVATE VPC (draftly-vpc)                   │
│                                                               │
│  ┌─────────────────────┐      ┌─────────────────────┐       │
│  │  Cloud SQL           │      │  Memorystore         │       │
│  │  PostgreSQL 16       │      │  Redis 7 (1 GB)      │       │
│  │  db-f1-micro         │      │  Basic Tier           │       │
│  │  Private IP only     │      │  Private IP only      │       │
│  └─────────────────────┘      └─────────────────────┘       │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

## Service Roles

| Service | Role | Ingress | Always On? |
|---------|------|---------|------------|
| draftly-gateway | REST API, WebSocket, OAuth, Gmail I/O, BullMQ workers | Public | Yes (min 1) |
| draftly-ai-worker | Celery workers: triage, draft generation, profile analysis | Internal only | Yes (min 1) |
| draftly-frontend | Static React app served via nginx | Public | No (scales to 0) |

## Why NOT a Separate AI Engine FastAPI Service?

The AI Engine's FastAPI server (`main.py`) only serves two endpoints:
- `/health` — deep health check (DB + Redis connectivity)
- `/ping` — liveness probe

It does zero business logic. All AI work happens in the Celery workers. In production on Cloud Run, the worker service already needs an HTTP port (Cloud Run requirement), so the FastAPI health endpoint is bundled with the worker container. No separate service needed.

## Networking Architecture

### VPC Connector

The Serverless VPC Access Connector bridges Cloud Run (serverless) with private resources (Cloud SQL, Memorystore).

```
Cloud Run Service → VPC Connector (10.8.0.0/28) → Private VPC → Cloud SQL / Memorystore
```

- Connector: `draftly-connector`
- IP Range: `10.8.0.0/28` (16 IPs, used by connector instances)
- Machine type: e2-micro (2-3 instances)
- All Cloud Run services route traffic through this connector

### Ingress Rules

| Service | Ingress Setting | Who Can Access |
|---------|----------------|----------------|
| draftly-gateway | All traffic | Anyone on the internet |
| draftly-frontend | All traffic | Anyone on the internet |
| draftly-ai-worker | Internal only | Only services within the same GCP project/VPC |

### Data Flow

```
User → Frontend (React) → Gateway (REST API) → Cloud SQL (read/write)
                                              → Redis/Memorystore (queue jobs)
                                              → Gmail API (fetch/send)

Redis Queue → AI Worker (Celery) → Cloud SQL (write results)
                                 → Redis (publish events)
                                 → LLM Provider (Gemini API)

Redis Pub/Sub → Gateway (WebSocket) → User (real-time notifications)
```

## GCP Services Used

| GCP Service | Purpose | Why This Service |
|-------------|---------|-----------------|
| Cloud Run | Container hosting | Serverless, auto-scaling, pay-per-use, no cluster management |
| Cloud SQL | PostgreSQL 16 database | Managed backups, patching, private IP, familiar Postgres |
| Memorystore | Redis 7 cache/queue broker | Managed Redis, private networking, compatible with Celery + BullMQ |
| Artifact Registry | Docker image storage | GCP-native, regional, integrates with Cloud Build |
| Secret Manager | Secrets storage | Versioned, audited, native Cloud Run integration |
| Serverless VPC Access | Private networking | Connects Cloud Run to Cloud SQL and Memorystore |

## Connection Pooling — PgBouncer Design Decision

### The Problem

PostgreSQL has a hard connection limit (default: 100). Each connection consumes ~10 MB of RAM on the server. At 300 concurrent users, the Gateway alone could try to open 300 connections — exceeding the limit and crashing the database.

### The Solution: PgBouncer

PgBouncer sits between the application and PostgreSQL, multiplexing many client connections into a small pool of actual database connections.

```
Without PgBouncer:
  300 concurrent users → Gateway (300 connections) → PostgreSQL (CRASH at 100 limit)

With PgBouncer:
  300 concurrent users → Gateway (200 client conns) → PgBouncer (40 actual conns) → PostgreSQL (OK)
```

### Who Uses PgBouncer and Who Doesn't

| Service | Connects To | Port | Why |
|---------|-------------|------|-----|
| Gateway (Node.js) | PgBouncer | 6432 | High concurrency — many short-lived queries from HTTP requests. PgBouncer multiplexes 200 client connections into 40 real connections. |
| AI Engine (Celery workers) | PostgreSQL directly | 5432 | Workers use `NullPool` (create → use → destroy per task). Each forked Celery process has its own event loop. PgBouncer's transaction pooling conflicts with SQLAlchemy async connections in this pattern. |

### Why the Gateway Needs It

The Gateway handles:
- REST API requests (each opens a DB connection for the query duration)
- WebSocket connections (long-lived, may query DB periodically)
- BullMQ workers (gmail-sync, send-reply — each holds a connection during processing)

With Knex.js pool config `min: 2, max: 20` per Gateway instance, and up to 5 instances on Cloud Run, that's potentially 100 connections from Gateway alone. PgBouncer keeps this manageable.

### Why the AI Worker Doesn't Need It

Celery workers:
- Fork child processes (each with its own event loop)
- Use `NullPool` — no persistent connection pool, create fresh connection per task
- Run at controlled concurrency (4-15 concurrent tasks max)
- Each task is short-lived (2-60 seconds), connection is destroyed after

At max concurrency of 15 triage + 8 draft + 3 profile = 26 simultaneous connections. Well within PostgreSQL's limits without pooling.

### Local Setup (Docker Compose)

```
Gateway → PgBouncer (:6432) → PostgreSQL (:5432)
Celery  → PostgreSQL (:5432) directly
```

PgBouncer config in docker-compose:
- `MAX_CLIENT_CONN: 200` (accepts up to 200 client connections)
- `DEFAULT_POOL_SIZE: 40` (maintains 40 real PostgreSQL connections)
- `POOL_MODE: transaction` (connection returned to pool after each transaction)

### GCP Production — Cloud SQL

Cloud SQL does NOT have a built-in PgBouncer equivalent. For production at scale, you have two options:

**Option A: Cloud SQL Auth Proxy (current plan, sufficient for 1000 users)**
- Cloud SQL handles connection management internally
- Gateway's Knex pool (max 20 per instance × 5 instances = 100 connections) is within Cloud SQL's default limit
- No separate PgBouncer needed at this scale

**Option B: Add PgBouncer on Cloud Run (needed at 5000+ users)**
- Deploy PgBouncer as a separate Cloud Run service or sidecar
- Gateway connects to PgBouncer Cloud Run service → PgBouncer connects to Cloud SQL
- Needed when total connections from all Gateway instances exceed Cloud SQL's limit (~500 for db-f1-micro)

**For your current scale (100-1000 users): Option A is sufficient.** Cloud SQL's db-f1-micro supports up to 25 concurrent connections, which is tight. If you hit connection limits during load testing, upgrade to db-g1-small (500 max connections) or add a PgBouncer sidecar.

### Load Testing Consideration

For local load testing (simulating 300 concurrent users), PgBouncer is essential. Without it, your local PostgreSQL will reject connections beyond its `max_connections` setting. The Docker Compose setup already includes PgBouncer — make sure the Gateway connects through port 6432, not 5432.

---

## Environment Variables in Production

### Gateway (draftly-gateway)

| Variable | Source | Value |
|----------|--------|-------|
| NODE_ENV | Env var | `production` |
| API_PORT | Env var | `3000` |
| DB_HOST | Env var | Cloud SQL private IP |
| DB_PORT | Env var | `5432` |
| DB_NAME | Env var | `draftly` |
| DB_USER | Env var | `draftly` |
| DB_PASSWORD | Secret Manager | `draftly-db-password` |
| REDIS_URL | Env var | `redis://MEMORYSTORE_IP:6379` |
| GOOGLE_CLIENT_ID | Secret Manager | `draftly-google-client-id` |
| GOOGLE_CLIENT_SECRET | Secret Manager | `draftly-google-client-secret` |
| SECRET_ENCRYPTION_KEY | Secret Manager | `draftly-encryption-key` |
| CORS_ORIGINS | Env var | Frontend Cloud Run URL |
| GOOGLE_CALLBACK_URL | Env var | Gateway Cloud Run URL + `/api/v1/auth/google/callback` |
| GMAIL_CALLBACK_URL | Env var | Gateway Cloud Run URL + `/api/v1/connections/callback` |

### AI Worker (draftly-ai-worker)

| Variable | Source | Value |
|----------|--------|-------|
| DB_HOST | Env var | Cloud SQL private IP |
| DB_PORT | Env var | `5432` |
| DB_NAME | Env var | `draftly` |
| DB_USER | Env var | `draftly` |
| DB_PASSWORD | Secret Manager | `draftly-db-password` |
| REDIS_URL | Env var | `redis://MEMORYSTORE_IP:6379` |
| GEMINI_API_KEY | Secret Manager | `draftly-gemini-api-key` |
| LLM_PRIMARY_MODEL | Env var | `gemini/gemini-2.0-flash` |
| LLM_FALLBACK_MODEL | Env var | `gemini/gemini-1.5-flash` |

---

## Metadata-First Sync Architecture

### Overview

Draftly uses a **metadata-first sync** strategy for Gmail integration. Instead of fetching full email bodies during sync (expensive, slow, quota-heavy), the system fetches only lightweight metadata (headers + snippet) and defers full body retrieval to the moment it's actually needed.

### Why Metadata-Only Sync

| Concern | Before (Full Fetch) | After (Metadata-First) |
|---------|---------------------|------------------------|
| **Response size per thread** | 5–50 KB (full body + attachments metadata) | ~1 KB (headers only) |
| **Sync time for 20 threads** | 15–45 seconds | 2–8 seconds |
| **Gmail API quota usage** | High (large payloads count against bandwidth quota) | Low (metadata responses are tiny) |
| **Database storage** | All bodies stored immediately (most never read) | Bodies stored only when accessed |
| **Scales to 1000 users** | Requires aggressive rate limiting | Comfortably within quota limits |

The Gmail API `threads.get` with `format: 'metadata'` returns only RFC 822 headers (From, To, Subject, Date, Message-ID) and labels. No body content is transferred. This is 10–50x smaller than `format: 'full'`.

### When Full Body Is Fetched (On-Demand)

Full body content is fetched from Gmail in exactly two scenarios:

1. **Thread Detail View** — When a user clicks on a thread in the inbox UI, the `GET /connections/:type/threads/:id` endpoint checks if messages have `body_text`. If not, it calls `GmailAdapter.fetchThreadFull()` to retrieve and cache the body in the database. First click takes 1–2s extra; subsequent clicks are instant (body is cached in DB).

2. **Draft Generation** — Before dispatching a draft generation task to Celery, the `POST /connections/:type/threads/:id/draft` and `POST .../regenerate` endpoints verify that body content exists. If missing, they fetch it from Gmail first. This ensures the LLM always has full context for reply generation.

### Data Flow

```
SYNC (fast, lightweight):
  Gmail API (threads.list) → thread stubs
  Gmail API (threads.get, format=metadata) → headers + labels only
  → Save to DB: subject, from, to, date, labels, snippet
  → body_text = NULL, body_html = NULL
  → Dispatch triage (works with metadata: subject, from, snippet)

ON-DEMAND (when user needs body):
  User clicks thread → Gateway checks body_text
  → If NULL: Gmail API (threads.get, format=full) → extract body → update DB
  → Return full thread to frontend

DRAFT GENERATION (needs body for LLM):
  User triggers draft → Gateway checks body_text
  → If NULL: Gmail API (threads.get, format=full) → extract body → update DB
  → Dispatch Celery task (body now available in DB for AI pipeline)
```

### How This Scales to 1000 Users

- **Sync phase**: 1000 users × 20 threads × 1 KB metadata = ~20 MB total bandwidth (vs 1–2 GB with full bodies)
- **Gmail API quota**: `threads.get` costs 5 quota units regardless of format. Metadata responses are faster to transfer, reducing timeout risk.
- **Database storage**: Only threads that users actually interact with store body content. For most users, only 20–30% of synced threads are ever opened.
- **Triage pipeline**: Already works with metadata only (subject, from, snippet) — no changes needed.
- **`fetchThreadFull` is idempotent**: Safe to call multiple times. If body is already cached, the DB update is a no-op overwrite.

### Key Implementation Details

- `email_messages.body_text` and `body_html` columns are nullable — no migration needed
- `is_sent_by_user` is determined from Gmail labels (`SENT` label), available in metadata format
- The `fetchThreadFull()` method on `GmailAdapter` fetches with `format: 'full'` and updates existing messages by `external_message_id`
- Snippet text (from `threads.list`) is available for triage even without body content
