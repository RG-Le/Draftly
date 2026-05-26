# Inter-Service Communication — Detailed Design

## The Problem

Two services (Node.js Gateway, Python AI Engine) need to coordinate work. They share a PostgreSQL database and a Redis instance. The question: how do they talk to each other?

---

## Communication Patterns Used

| Interaction | Pattern | Mechanism | Direction |
|-------------|---------|-----------|-----------|
| Enqueue AI work (triage, draft, profile) | Async job queue | Redis (Celery protocol) | Node → Python |
| Wakeup AI Engine from scale-to-zero | HTTP GET fire-and-forget | FastAPI `/ping` | Node → Python |
| Notify user of AI results | Pub/sub event | Redis pub/sub | Python → Node |
| Share data (threads, drafts, profiles) | Shared database | PostgreSQL | Both read/write |
| Health check Python service | HTTP GET | FastAPI `/health` | Node → Python |

---

## Decision: Why Not gRPC or REST Between Services

| Option | Verdict | Reason |
|--------|---------|--------|
| gRPC | ❌ | Type-safe and fast, but 90% of Node→Python interactions are async ("process this later"). gRPC's strength is synchronous RPC — wasted here. Proto file maintenance adds overhead for 2 RPCs (health + maybe schema sync). |
| REST (Node calls Python HTTP) | ❌ | Creates a synchronous dependency. If Python is slow or down, Node's API blocks. Our workload is fundamentally async. |
| **Redis queues + pub/sub + shared DB** | ✅ | Async by nature. Node doesn't wait for Python. Jobs queue safely if Python is temporarily down. Pub/sub gives real-time events without polling. Shared DB avoids data serialization between services. |

**When gRPC would be right:** If we had synchronous calls like "classify this email right now and return the result before responding to the user." We don't — all AI work is background.

**When REST would be right:** If services had different databases and needed to exchange data. We share PostgreSQL — no need.

---

## Node → Python: CeleryBridge

Node enqueues jobs for Python by writing Celery-compatible messages to Redis. This is Celery's documented v2 wire protocol — not a hack.

### How it works

```
Node.js CeleryBridge → Redis LPUSH to queue key → Celery worker BRPOP from same key
```

### CeleryBridge Methods

```typescript
class CeleryBridge {
  dispatchTriageTask({ threadId, userId, correlationId }): Promise<string>;
  dispatchTriageBatchTask({ threadIds, userId, correlationId }): Promise<string>;
  dispatchDraftTask({ threadId, userId, correlationId }): Promise<string>;
  dispatchProfileUpdateTask({ userId, draftId, correlationId }): Promise<string>;
  dispatchProfileBuildTask({ userId, correlationId }): Promise<string>;
  private pingAiWorker(): Promise<void>;  // Fire-and-forget wakeup
}
```

### Wakeup Ping (Scale-to-Zero)

Because the AI Engine runs on Cloud Run with `min-instances=0`, its container may be frozen when a task is dispatched. To minimise cold-start latency, `CeleryBridge` sends a `GET /ping` to the AI Engine's FastAPI endpoint **immediately after** every `LPUSH` to Redis:

```
CeleryBridge.dispatchXxxTask()
  ├─ LPUSH job → Redis  (task queued)
  └─ GET /ping → AI Engine (async, fire-and-forget, up to 3 retries × 500 ms)
                   └─ Container wakes up in ~2s
                   └─ Celery BRPOP picks up job and processes it
```

Ping failures are **logged as warnings and never block dispatch** — the Celery retry mechanism (`max_retries=2`) provides the safety net if the worker is momentarily unready.

The `AI_WORKER_URL` environment variable controls where the ping is sent:
- **Local Docker:** `http://ai-engine-api:8000` (Docker network hostname)
- **Cloud Run:** `https://draftly-ai-worker-XXXXX.a.run.app` (set via `--update-env-vars`)

### Message format

The CeleryBridge builds Celery v2 protocol messages with base64-encoded body:

```json
{
  "body": "[[], {\"thread_id\": \"uuid\", \"correlation_id\": \"uuid\"}, {}]",
  "headers": {
    "id": "task-uuid",
    "task": "ai.triage.classify",
    "lang": "py",
    "root_id": "task-uuid"
  },
  "properties": {
    "delivery_tag": "uuid",
    "delivery_mode": 2
  },
  "content-type": "application/json",
  "content-encoding": "utf-8"
}
```

### Queue names

| Queue | Tasks | Consumer |
|-------|-------|----------|
| `triage-queue` | `ai.triage.classify`, `ai.triage.classify_batch` | Python Celery worker |
| `draft-queue` | `ai.draft.generate` | Python Celery worker |
| `profile-queue` | `ai.profile.build` | Python Celery worker |

### Batch Triage

The primary triage path uses batch classification. After Gmail sync, the gateway collects all unclassified thread IDs and dispatches them in chunks (configurable via `TRIAGE_BATCH_SIZE`, default 25). The batch task classifies multiple threads in a single LLM call, significantly reducing cost and latency.

### Failure handling

- If Redis is down: Node cannot enqueue. API returns 503. User retries later.
- If Python is down: Jobs accumulate in Redis. When Python restarts, it processes the backlog. No data loss (Redis AOF persistence).
- If job fails: Celery's retry mechanism handles it (configured per task). After max retries, job goes to dead letter queue.

### Why not BullMQ for Python too?

BullMQ is Node.js only. There's no official Python BullMQ consumer. We'd have to build one or use a third-party wrapper. Celery is the standard Python task queue — using it with Redis as broker is the path of least resistance.

---

## Python → Node: Redis Pub/Sub Events

When Python finishes processing (triage complete, draft ready, etc.), it publishes an event to a Redis pub/sub channel. Node's WebSocket Manager subscribes to this channel and forwards events to the correct user.

### Channel

Single channel: `draftly:events`

### Message format

```json
{
  "event": "draft:ready",
  "userId": "user-uuid",
  "payload": {
    "draftId": "draft-uuid",
    "threadId": "thread-uuid",
    "subject": "Re: Q3 Budget Review"
  },
  "correlationId": "correlation-uuid",
  "timestamp": "2026-04-18T10:30:00Z"
}
```

### Event types

| Event | When | Contains |
|-------|------|----------|
| `triage:started` | Triage task begins | userId, threadId, correlationId |
| `triage:completed` | Triage pipeline finishes | userId, threadId, correlationId, classification, confidence, reasoning |
| `triage:batch_started` | Batch triage begins | userId, threadCount, correlationId |
| `triage:batch_completed` | Batch triage finishes | userId, results (array of thread classifications) |
| `triage:batch_retrying` | Batch triage retry | userId, attempt, maxAttempts, retryInSeconds |
| `triage:batch_failed` | Batch triage permanently failed | userId, error, threadCount, permanent |
| `draft:ready` | Draft generation succeeds | userId, draftId, threadId |
| `draft:failed` | Draft generation fails | userId, threadId, error |
| `profile:updated` | Profile update applied | userId |
| `profile_generated` | Profile pipeline completed | userId |

### Node-side handling

```typescript
// WSManager subscribes to Redis pub/sub
redisSub.subscribe('draftly:events');
redisSub.on('message', (channel, message) => {
  const event = JSON.parse(message);
  // Forward to the specific user's WebSocket room
  io.to(`user:${event.userId}`).emit(event.event, event.payload);
});
```

### Why pub/sub and not another queue?

Pub/sub is fire-and-forget. If no Node instance is listening, the event is lost. This is acceptable because:
- Events are notifications, not critical data. The draft is already stored in PostgreSQL.
- If the user's WebSocket is disconnected, they'll see the draft when they next poll the API.
- If Node was temporarily down, the user refreshes and sees updated state from DB.

**When pub/sub would be wrong:** If events carried data that only exists in the event (not in DB). Then losing an event means losing data. We don't do this — events are pointers to data already in PostgreSQL.

---

## Shared PostgreSQL: The State Bridge

Both services read and write the same PostgreSQL database. This is the simplest form of data sharing and works well at our scale.

### Who writes what

| Table | Node writes | Python writes |
|-------|:-----------:|:-------------:|
| users | ✅ | — |
| user_connections | ✅ | — |
| email_threads | ✅ | — |
| email_messages | ✅ | — |
| triage_results | — | ✅ |
| drafts | ✅ (edit, approve, reject) | ✅ (create after generation) |
| draft_actions | ✅ | — |
| send_attempts | ✅ | — |
| user_profiles | ✅ (manual update) | ✅ (AI update) |
| user_preferences | ✅ | — |
| usage_records | ✅ (Gmail usage) | ✅ (LLM usage) |
| audit_logs | ✅ | ✅ |

### Conflict point: `drafts` table

Both services write to `drafts`. Potential conflict:
- Python creates draft (status: `draft_ready`)
- User edits draft via Node (status: `draft_edited`)
- These don't conflict because they happen sequentially (draft must exist before user can edit)

The `version` column prevents concurrent edit conflicts between two user requests (optimistic locking).

### Why shared DB works here (and when it wouldn't)

**Works because:**
- 1000 users, not 100k — write contention is low
- Write patterns don't overlap heavily (see table above)
- Both services use connection pooling through PgBouncer
- Schema is managed by one migration tool (Knex in Node)

**Would break when:**
- Services need independent deployment cycles with breaking schema changes
- Write volume causes lock contention on hot tables
- You need different DB technologies per service (e.g., Python wants MongoDB for profiles)
- At 10k+ users, you'd likely split: core DB (Node) + AI results DB (Python)

---

## Correlation ID Flow

Every user action generates a correlation ID that follows the request across both services.

```
User request → Node (generates ID) → Redis job (carries ID) → Python task (logs with ID)
                                                                      ↓
                                            Redis pub/sub event (carries ID) → Node WebSocket
```

This means you can search logs by correlation ID and see the entire lifecycle:
1. Node API received sync request
2. Node enqueued triage job for thread X
3. Python picked up triage job, classified as reply_needed
4. Python enqueued draft job
5. Python generated draft, published event
6. Node forwarded WebSocket notification to user

---

## Monitoring the Communication Layer

| Metric | What it tells you |
|--------|------------------|
| `celery_queue_depth{queue="triage-queue"}` | How far behind AI processing is |
| `celery_task_duration_seconds` | How long AI tasks take |
| `celery_task_failures_total` | AI pipeline failure rate |
| `redis_pubsub_messages_total` | Event throughput |
| `redis_connected_subscribers` | How many Node instances are listening |
| `pgbouncer_active_connections` | DB connection pressure from both services |
