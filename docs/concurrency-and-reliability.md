# Concurrency & Reliability — Detailed Design

## Scale Target

| Metric | Value |
|--------|-------|
| Registered users | 1,000 |
| Peak concurrent users | ~300 |
| API requests/sec (peak) | ~150–300 |
| WebSocket connections (peak) | ~300 |
| Background jobs in flight (peak) | ~50–80 |

---

## Concurrency Protection Mechanisms

### 1. Idempotent Send (prevents duplicate emails)

**The problem:** User clicks "Approve" twice. Network retry causes duplicate enqueue. Worker crashes mid-send and retries. Any of these can send the same email twice.

**The solution:**

```
Approve action
  → Generate idempotency key: "send:{draftId}:v{version}"
  → INSERT into send_attempts (UNIQUE on idempotency_key)
  → Redis SET NX (lock for 300s)
  → Worker picks up job
  → Worker checks: was this key already marked "sent"? → abort if yes
  → Worker sends via Gmail API
  → Worker marks "sent" + stores external message ID
```

Three layers of protection:
1. **DB UNIQUE index** on `send_attempts.idempotency_key` — no duplicate records
2. **Redis NX lock** — prevents concurrent processing of the same key
3. **Worker pre-check** — verifies status before making the Gmail API call

**When this fails:** If Redis is down AND two workers pick up the job simultaneously AND the DB insert doesn't catch the duplicate (near impossible but documented for honesty).

### 2. Optimistic Locking (prevents lost edits)

**The problem:** User A loads draft (version 2). User B loads same draft (version 2). Both edit. One edit overwrites the other.

**The solution:**

```sql
UPDATE drafts
SET current_content = $new_content,
    version = version + 1,
    updated_at = NOW()
WHERE id = $draft_id
  AND user_id = $user_id
  AND version = $expected_version
RETURNING *;
```

If `rowCount = 0`, the draft was modified since the user loaded it → return 409 Conflict.

**Why optimistic over pessimistic locking:**
- Pessimistic (SELECT FOR UPDATE) holds a row lock until transaction completes. If transaction is slow, other readers block.
- Optimistic assumes conflicts are rare (true for us — one user per draft). Only checks at write time.
- At 1000 users, each user edits their own drafts. Conflicts between different users on the same draft are impossible (drafts are user-scoped). Conflicts between two tabs of the same user are rare.

**When optimistic locking is wrong:** If you expect frequent write conflicts on the same row (e.g., a shared document with multiple editors). Use pessimistic locking or OT/CRDT then.

### 3. Distributed Lock (prevents parallel syncs)

**The problem:** User triggers manual sync. Scheduled sync also fires. Both fetch the same inbox simultaneously. Duplicate messages get stored (or the dedup logic handles it but wastes Gmail API quota).

**The solution:**

```typescript
const lock = await redlock.lock(`sync:user:${userId}`, 120_000);  // 120s TTL
try {
  await performSync(userId);
} finally {
  await lock.release();
}
```

If lock acquisition fails, the job is retried after a delay.

**Why Redlock over simple Redis SETNX:**
- Redlock (by Redis creator) handles edge cases: clock drift, partial failures, lock auto-release on crash.
- Simple SETNX works for local dev but isn't safe for production if you ever run multiple Redis nodes.

**When distributed locks are overkill:** If duplicate operations are harmless (e.g., reading cached data twice). Only lock when duplicate operations cause side effects (duplicate API calls, duplicate DB writes).

### 4. Transaction Boundaries (atomic operations)

**The problem:** Approve writes to `drafts` (status: approved) and creates a `send_attempts` record. If the second write fails, you have an approved draft with no send attempt → email never gets sent.

**The solution:**

```typescript
await db.transaction(async (trx) => {
  // 1. Update draft status (with optimistic lock)
  const draft = await trx('drafts')
    .where({ id: draftId, version: expectedVersion })
    .update({ status: 'approved' })
    .returning('*');
  
  if (draft.length === 0) throw new ConcurrencyConflictError();
  
  // 2. Create send attempt
  await trx('send_attempts').insert({ ... });
  
  // 3. Create audit log
  await trx('audit_logs').insert({ ... });
  
  // 4. Enqueue send job AFTER transaction commits
  trx.afterCommit(async () => {
    await sendQueue.add('send-reply', { ... });
  });
});
```

**Why `afterCommit` for queue enqueue:**
- If job is enqueued during the transaction and the transaction rolls back, the worker will try to process a non-existent send attempt.
- `afterCommit` guarantees the data exists in DB before the worker sees the job.

### 5. Circuit Breaker (prevents cascade failures)

**The problem:** Gmail API goes down. Every sync job fails. Every failure adds to retry queue. Queue floods. When Gmail comes back, burst of requests triggers rate limiting.

**The solution:**

```
Normal (closed) → 5 consecutive failures → Open (all calls fail fast for 60s)
                                             → Half-open (one probe request)
                                               → Success → Closed (normal)
                                               → Failure → Open again
```

Applied to:
- Gmail API calls (per user connection)
- LLM provider calls (per model)

**When circuit breaker is wrong:** For operations that must attempt regardless of history (e.g., a critical health check). Don't circuit-break the health check itself.

### 6. Queue Concurrency Limits (backpressure)

| Queue | Concurrency | Why this number |
|-------|-------------|-----------------|
| `gmail-sync-queue` | 10 | Gmail API quota: 250 units/user/sec shared. 10 concurrent syncs × ~25 API calls each is within safe limits. |
| `gmail-send-queue` | 5 | Send is latency-sensitive but low volume. 5 concurrent is far more than needed for 300 users. |
| `triage-queue` | 15 | Heuristic path is fast (~10ms). LLM path is ~2s. Mixed concurrency of 15 handles both. |
| `draft-queue` | 8 | LLM-bound. Each draft takes 3–8s. 8 concurrent = ~60–150 drafts/min capacity. |
| `profile-queue` | 3 | Low priority. Only runs after approved sends. 3 is plenty. |

**Concurrency vs rate limit:**
- Concurrency = how many jobs run simultaneously
- Rate limit = how many jobs start per time window

Both are configured per queue. Rate limits prevent burst overload of external APIs. Concurrency prevents worker memory exhaustion.

### 7. Deduplication (prevents duplicate storage)

**Gmail messages:**

```sql
CREATE UNIQUE INDEX idx_messages_external ON email_messages(external_message_id);

-- On upsert:
INSERT INTO email_messages (...)
VALUES (...)
ON CONFLICT (external_message_id) DO NOTHING;
```

If a sync job processes a message that's already stored, the insert is silently skipped. No error, no duplicate.

**Gmail threads:**

```sql
CREATE UNIQUE INDEX idx_threads_external ON email_threads(connection_id, external_thread_id);
```

Same pattern. Thread metadata is updated on conflict (message_count, last_message_at), content is not duplicated.

---

## Reliability Model

### What We Protect Strongly (consistency > availability)

| Operation | Protection | If it fails |
|-----------|-----------|-------------|
| Draft approval | Transaction + optimistic lock | 409 Conflict → user retries |
| Send dispatch | Idempotency key + distributed lock | Job retries safely |
| Send recording | Transaction (send result → DB) | Worker retries on crash recovery |
| Token refresh | Atomic update (encrypted) | Connection marked "expired," user re-auths |

### What Can Be Eventually Consistent

| Operation | Acceptable delay | Why |
|-----------|-----------------|-----|
| Dashboard thread list | 5–10 seconds | Not critical if inbox refresh is slightly stale |
| Triage result display | 10–30 seconds | User sees "classifying..." then result appears |
| Draft generation | 30–60 seconds | User sees "generating..." then draft appears |
| Usage summary | 5 minutes | Cached, not real-time |
| Profile update | Minutes | Low priority, async |

---

## Failure Scenarios & Recovery

| Failure | Impact | Recovery |
|---------|--------|----------|
| Redis down | No queues, no pub/sub, no rate limiting, no caching | Gateway returns 503 for async ops. Sync read operations (from DB) still work. Restore Redis (AOF persistence). |
| PostgreSQL down | All reads and writes fail | Both services return 500. PgBouncer retries connections. Restore DB. |
| Python AI Engine down | No triage, no drafts, no profile updates | Jobs queue in Redis (safe). Gateway API works for reads, approvals queue but don't process. AI Engine restart catches up on backlog. |
| Gmail API down | No sync, no sends | Circuit breaker opens. Sync jobs fail gracefully. Send jobs retry exponentially. User sees "Gmail temporarily unavailable." |
| LLM provider down | No triage (LLM path), no drafts | Circuit breaker triggers fallback model. If fallback also fails, draft generation fails gracefully. Thread stays in "triaged" state. User can retry later. |
| Node Gateway crash | API unavailable | Load balancer routes to other instances. BullMQ jobs in flight are redelivered (acks_late). WebSocket connections drop but client reconnects. |
| Celery worker crash | Task in progress is lost | `reject_on_worker_lost=True` requeues the task. `acks_late=True` ensures unfinished tasks aren't acknowledged. |
