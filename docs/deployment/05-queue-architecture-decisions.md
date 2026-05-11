# Queue Architecture Decisions

## Current Queue Setup

Draftly uses two queue systems, both backed by the same Redis instance:

| Queue System | Service | Language | Purpose |
|---|---|---|---|
| **BullMQ** | Gateway (Node.js) | TypeScript | Gmail sync jobs, send reply jobs, draft sync |
| **Celery** | AI Engine (Python) | Python | Triage, draft generation, profile analysis |

### How They Communicate

```
Gateway (Node.js)                    AI Engine (Python)
┌─────────────────┐                 ┌─────────────────┐
│  BullMQ Workers │                 │  Celery Workers  │
│  - gmail-sync   │                 │  - triage-queue  │
│  - gmail-send   │                 │  - draft-queue   │
│  - draft-sync   │                 │  - profile-queue │
└────────┬────────┘                 └────────┬────────┘
         │                                   │
         │         ┌───────────┐             │
         └────────►│   Redis   │◄────────────┘
                   │  (single) │
                   └───────────┘
                        ▲
                        │
              CeleryBridge (Node writes
              Celery-compatible messages
              directly to Redis)
```

The Gateway dispatches AI tasks to Python by writing Celery v2 protocol messages directly to Redis using the `CeleryBridge` class. This is not a hack — it's Celery's documented wire protocol.

---

## Why BullMQ for Node.js?

| Factor | BullMQ | Alternatives |
|--------|--------|-------------|
| Language | Node.js native | — |
| Broker | Redis (already in stack) | — |
| Features | Priorities, rate limiting, repeatable jobs, delayed jobs | — |
| Monitoring | Bull Board UI | — |
| Maturity | Production-proven, active development | — |

BullMQ was chosen because:
1. It's the standard Node.js job queue
2. It uses Redis — which we already need for Celery, pub/sub, and caching
3. It supports repeatable jobs (scheduled Gmail sync every 5 minutes)
4. It has built-in rate limiting (important for Gmail API quotas)

---

## Why Celery for Python?

| Factor | Celery | Alternatives |
|--------|--------|-------------|
| Language | Python standard | — |
| Broker | Redis (already in stack) | — |
| Features | Retry, rate limiting, priority, task routing, monitoring (Flower) | — |
| Scaling | Add more workers trivially | — |
| Maturity | 10+ years, industry standard | — |

Celery was chosen because:
1. It's the de facto Python task queue
2. It uses Redis as broker — same Redis instance as BullMQ
3. Task routing lets us isolate queues (triage vs draft vs profile)
4. Worker concurrency is configurable per queue
5. `acks_late` + `reject_on_worker_lost` ensures no task loss

---

## Why NOT RabbitMQ?

| Consideration | RabbitMQ | Our Redis-based Setup |
|---|---|---|
| Extra infrastructure | Yes (separate service to manage) | No (Redis already required) |
| Protocol | AMQP (complex, powerful) | Simple LPUSH/BRPOP |
| Routing | Exchange/binding/queue topology | Simple named queues |
| Message ordering | Guaranteed per queue | Guaranteed per queue |
| Persistence | Disk-backed queues | Redis AOF persistence |
| Throughput | 50k+ msg/sec | 10k+ msg/sec (more than enough) |
| Monitoring | Management UI built-in | Flower (Celery) + Bull Board |
| Learning curve | Medium (AMQP concepts) | Low (just Redis) |

**Verdict: RabbitMQ adds operational complexity for zero benefit at our scale.**

RabbitMQ shines when you need:
- Complex routing (topic exchanges, headers-based routing, dead letter exchanges with routing)
- 100k+ messages/second throughput
- Multi-consumer patterns with acknowledgment guarantees beyond what Redis provides
- Protocol-level features (message TTL, priority queues with 255 levels)

We process maybe 50-100 messages/minute at peak. Redis handles this trivially.

**When we'd switch to RabbitMQ:**
- If we needed complex message routing between 10+ services
- If Redis memory became a bottleneck (unlikely — our queue messages are small)
- If we needed guaranteed exactly-once delivery (Redis provides at-least-once with Celery's acks_late)

---

## Why NOT Google Cloud Tasks?

| Consideration | Cloud Tasks | Our Celery Setup |
|---|---|---|
| Model | Push-based (calls your HTTP endpoint) | Pull-based (worker polls queue) |
| Worker control | Cloud Tasks decides when to call you | Worker controls concurrency |
| Long tasks | 30 min max (HTTP timeout) | No limit (Celery tasks can run hours) |
| Local development | Requires emulator or cloud connection | Works locally with Redis |
| Vendor lock-in | GCP-specific | Portable (works anywhere with Redis) |
| Cost | $0.40 per million tasks | Free (just Redis cost) |
| Retry logic | Built-in but limited | Celery: full control (exponential backoff, max retries, custom) |

**Verdict: Cloud Tasks is push-based, which is wrong for CPU-heavy LLM work.**

The fundamental issue: Cloud Tasks pushes work to your service via HTTP. This means:
- Cloud Tasks decides concurrency (how many requests hit your service simultaneously)
- Your service must handle HTTP requests while doing heavy LLM processing
- You can't control backpressure — if the LLM is slow, Cloud Tasks keeps pushing

With Celery (pull-based):
- The worker decides when to pick up the next task
- `worker_prefetch_multiplier=1` means "only fetch one task at a time"
- If LLM calls are slow, the worker naturally slows down without overwhelming anything

**When Cloud Tasks would be right:**
- Lightweight HTTP-triggered tasks (send email, resize image, webhook delivery)
- When you want zero infrastructure (no Redis to manage)
- When tasks complete in under 30 minutes reliably

---

## Why NOT Google Cloud Pub/Sub?

| Consideration | Cloud Pub/Sub | Our Setup |
|---|---|---|
| Model | Pub/sub with pull or push subscriptions | Celery queues + Redis pub/sub |
| Ordering | Per-key ordering (complex) | FIFO per queue (simple) |
| At-least-once | Yes | Yes (Celery acks_late) |
| Exactly-once | Yes (with ordering keys) | No (at-least-once, idempotent tasks) |
| Cost | $40/TiB ingested + $0.04/million operations | Free (Redis cost only) |
| Local dev | Requires emulator | Works with local Redis |

**Verdict: Pub/Sub is designed for event streaming between microservices, not job queues.**

Pub/Sub is great for:
- Fan-out (one event → many subscribers)
- Event streaming (analytics, logging pipelines)
- Decoupling services that don't share a database

We don't need fan-out. Each task goes to exactly one worker. Celery queues are simpler and more appropriate.

**We DO use Redis pub/sub** for one thing: real-time event notifications (Python → Node WebSocket). This is fire-and-forget — if the event is lost, the user just refreshes and sees the data from the database.

---

## Why NOT Amazon SQS?

| Consideration | SQS | Our Setup |
|---|---|---|
| Cloud | AWS | GCP |
| Cross-cloud latency | Yes (if we're on GCP) | No |
| Cost | $0.40/million requests | Free (Redis) |
| FIFO | Optional (costs more) | Default with Redis |
| Visibility timeout | Yes (complex) | Celery handles this |

**Verdict: We're on GCP. Using an AWS service adds cross-cloud latency and complexity for no benefit.**

---

## The Real Reason: Redis is Already There

The strongest argument for BullMQ + Celery is that **Redis is already a required component** of our architecture for:

1. **Celery broker** — Python task queue
2. **BullMQ broker** — Node.js task queue
3. **Pub/sub events** — Real-time notifications (Python → Node → WebSocket)
4. **Rate limiting** — Redis-backed rate limiter in Gateway
5. **Caching** — Short-lived cache for various lookups

Adding RabbitMQ, Cloud Tasks, or Pub/Sub means managing an additional service for functionality Redis already provides. At 1000 users, this is unjustified complexity.

---

## Queue Configuration Summary

### BullMQ Queues (Node.js Gateway)

| Queue | Concurrency | Purpose |
|-------|-------------|---------|
| `gmail-sync` | 5 | Fetch emails from Gmail API |
| `gmail-send` | 5 | Send approved replies via Gmail API |
| `draft-sync` | 3 | Sync drafts to Gmail drafts folder |

### Celery Queues (Python AI Engine)

| Queue | Concurrency | Purpose | Typical Task Duration |
|-------|-------------|---------|----------------------|
| `triage-queue` | 15 | Email classification (heuristic + LLM) | 2-10s |
| `draft-queue` | 8 | Draft generation via LLM | 5-30s |
| `profile-queue` | 3 | User profile analysis | 10-60s |

### Task Routing

```python
# Celery task routes
task_routes = {
    "ai.triage.*": {"queue": "triage-queue"},
    "ai.draft.*": {"queue": "draft-queue"},
    "ai.profile.*": {"queue": "profile-queue"},
}
```

### Failure Handling

| Scenario | Behavior |
|----------|----------|
| Redis down | Gateway returns 503, tasks queue when Redis recovers |
| Worker crashes mid-task | `reject_on_worker_lost=True` re-queues the task |
| Task fails | Retry with exponential backoff (max 2 retries) |
| Max retries exceeded | Task goes to dead letter / marked as failed |
| LLM timeout | Task retries once, then marks thread for manual retry |

---

## Future Considerations

### If We Outgrow Redis Queues (10k+ users)

At very high scale, consider:
1. **Dedicated Redis for queues** — separate from cache/pub/sub Redis
2. **Redis Cluster** — for horizontal scaling of queue throughput
3. **RabbitMQ** — if we need complex routing between many services
4. **Cloud Tasks + Cloud Run** — if we decompose into many small serverless functions

### If We Move to GKE

On Kubernetes, the queue architecture stays the same:
- Redis runs as a StatefulSet (or still use Memorystore)
- Celery workers run as a Deployment with HPA (Horizontal Pod Autoscaler)
- BullMQ workers run inside the Gateway pods
- Scale workers independently based on queue depth
