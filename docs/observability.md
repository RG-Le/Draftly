# Observability — Detailed Design

## Three Pillars

| Pillar | Tool (Local) | Tool (Production) | Purpose |
|--------|-------------|-------------------|---------|
| Metrics | Prometheus + Grafana | Same (managed or self-hosted) | Dashboards, alerting, capacity planning |
| Logging | Pino (Node) + structlog (Python) → stdout | → Loki, ELK, or CloudWatch | Debugging, audit, troubleshooting |
| Tracing | Correlation ID (custom) | → OpenTelemetry (future) | Cross-service request tracing |

---

## Metrics

### What We Expose

All metrics use Prometheus client libraries (`prom-client` for Node, `prometheus_client` for Python).

**Node Gateway metrics:**

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_request_duration_seconds` | Histogram | method, route, status | API latency (p50, p95, p99) |
| `http_requests_total` | Counter | method, route, status | Request throughput + error rate |
| `websocket_connections_active` | Gauge | — | Current connected users |
| `bullmq_queue_depth` | Gauge | queue | Pending jobs per queue |
| `bullmq_job_duration_seconds` | Histogram | queue, status | Worker job performance |
| `gmail_api_calls_total` | Counter | operation, status | Gmail API usage |
| `token_refresh_total` | Counter | status | OAuth token refresh tracking |

**Python AI Engine metrics:**

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `celery_task_duration_seconds` | Histogram | task, status | Pipeline stage timing |
| `celery_task_total` | Counter | task, status | Task success/failure rate |
| `llm_request_duration_seconds` | Histogram | model, status | LLM call latency |
| `llm_tokens_total` | Counter | model, type (input/output) | Token consumption |
| `llm_estimated_cost_usd` | Counter | model | Running cost tracker |
| `triage_classification_total` | Counter | classification, method | Classification distribution |
| `pipeline_stage_duration_seconds` | Histogram | pipeline, stage | Per-stage timing |

### Alert Thresholds

| Metric | Condition | Severity | Action |
|--------|-----------|----------|--------|
| `http_request_duration_seconds` p99 | > 2s for 5 min | Warning | Check DB queries, external APIs |
| `http_requests_total` 5xx rate | > 1% for 5 min | Critical | Check logs, recent deploy |
| `bullmq_queue_depth{queue="draft-queue"}` | > 100 for 10 min | Warning | Scale AI workers |
| `bullmq_queue_depth{queue="gmail-send-queue"}` | > 20 for 5 min | Critical | Check Gmail API status |
| `celery_task_total{status="failure"}` | > 10/hour any task | Warning | Check LLM provider, DB |
| `llm_request_duration_seconds` p95 | > 15s for 5 min | Warning | LLM provider degraded |
| `llm_estimated_cost_usd` hourly rate | > $5/hour | Critical | Cost runaway — check for loops |
| `token_refresh_total{status="failure"}` | > 5 in 1 hour | Warning | Users' Gmail connections failing |

---

## Logging

### Format

Structured JSON. Both services output to stdout. Docker captures and forwards.

**Node (Pino):**

```json
{
  "level": "info",
  "time": "2026-04-18T10:30:00.000Z",
  "correlationId": "corr-uuid",
  "userId": "user-uuid",
  "msg": "draft.approved",
  "draftId": "draft-uuid",
  "version": 3,
  "responseTime": 45
}
```

**Python (structlog):**

```json
{
  "level": "info",
  "timestamp": "2026-04-18T10:30:01.000Z",
  "correlation_id": "corr-uuid",
  "task_id": "celery-uuid",
  "event": "draft.generated",
  "thread_id": "thread-uuid",
  "model": "gemini-2.0-flash",
  "input_tokens": 1200,
  "output_tokens": 350,
  "duration_ms": 4200
}
```

### What We Log

| Event | Level | Service | Key fields |
|-------|-------|---------|------------|
| API request received | info | Gateway | correlationId, method, path, userId |
| API request completed | info | Gateway | correlationId, status, responseTime |
| Auth login | info | Gateway | userId, authProvider |
| Auth failure | warn | Gateway | email (hashed), reason |
| Gmail sync started | info | Gateway | connectionId, correlationId |
| Gmail sync completed | info | Gateway | connectionId, newMessages, duration |
| Gmail API error | error | Gateway | connectionId, error, statusCode |
| Token refresh failed | warn | Gateway | connectionId, error |
| Celery task started | info | AI Engine | taskId, correlationId, taskName |
| Triage completed | info | AI Engine | threadId, classification, method, confidence |
| Draft generated | info | AI Engine | draftId, model, tokens, duration |
| Draft validation failed | warn | AI Engine | draftId, reason |
| LLM call failed | error | AI Engine | model, error, correlationId |
| Circuit breaker opened | warn | AI Engine | model, failureCount |
| Send attempt | info | Gateway | draftId, idempotencyKey |
| Send success | info | Gateway | draftId, externalMessageId |
| Send failure | error | Gateway | draftId, error, attemptNumber |
| Rate limit hit | warn | Gateway | userId or IP, endpoint, limit |
| Budget exceeded | warn | AI Engine | userId, budgetType, current, limit |

### What We NEVER Log

- Email bodies or subjects
- Email addresses (except hashed for auth failures)
- Draft content
- OAuth tokens
- Passwords
- User profile details

---

## Correlation ID

Every user request generates a UUID correlation ID that flows through the entire system.

```
User request
  → Node API (generates correlationId, attaches to logger context)
    → Redis job (includes correlationId in task kwargs)
      → Python Celery task (binds correlationId to structlog context)
        → Redis pub/sub event (includes correlationId)
          → Node WebSocket (logs correlationId)
```

**How to search logs:**

```bash
# Find all logs for a specific user request
grep "corr-uuid-123" logs/*.json

# Or with a log aggregator
query: correlation_id="corr-uuid-123"
```

This shows the full lifecycle: API received sync request → enqueued triage → classified as reply_needed → generated draft → notified user.

---

## Health Check Endpoints

**Node Gateway:** `GET /api/v1/admin/health`

```json
{
  "status": "healthy",
  "uptime": 86400,
  "components": {
    "database": { "status": "up", "latencyMs": 3 },
    "redis": { "status": "up", "latencyMs": 1 },
    "aiEngine": { "status": "up", "latencyMs": 15 }
  },
  "queues": {
    "gmail-sync-queue": { "waiting": 5, "active": 3, "failed": 0 },
    "gmail-send-queue": { "waiting": 0, "active": 1, "failed": 0 }
  }
}
```

**Python AI Engine:** `GET :8000/health`

```json
{
  "status": "healthy",
  "components": {
    "database": { "status": "up", "latencyMs": 2 },
    "redis": { "status": "up", "latencyMs": 1 },
    "llm": { "status": "up", "primaryModel": "gemini-2.0-flash" }
  },
  "celery": {
    "activeWorkers": 4,
    "queues": {
      "triage-queue": { "waiting": 12, "active": 8 },
      "draft-queue": { "waiting": 4, "active": 3 },
      "profile-queue": { "waiting": 0, "active": 0 }
    }
  }
}
```

**Health check logic:**
- DB: Execute `SELECT 1`, measure latency
- Redis: Execute `PING`, measure latency
- AI Engine (from Node): HTTP GET to Python's `/health`
- LLM: Check circuit breaker state (don't make a real LLM call)
- Status is "degraded" if any component latency > threshold, "unhealthy" if any component is down
