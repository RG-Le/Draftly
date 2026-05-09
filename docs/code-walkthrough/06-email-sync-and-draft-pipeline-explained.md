# Email Sync & Draft Pipeline Explained (Code Walkthrough)

This document answers:

1. **What triggers Gmail sync / “Draftly” processing** — manual paths and whether there is scheduled (e.g. daily) automation.
2. **The full Draftly AI path** — from Gateway through Redis queues into the AI engine, then **back through Redis/BullMQ** for Gmail-side drafts.

---

## 1) Naming: three different Redis-backed mechanisms

| Mechanism | Library / pattern | Purpose in this repo |
|-----------|-------------------|---------------------|
| **BullMQ** (`bullmq` package on Node) | Redis + BullMQ internals | **`gmail-sync`**, **`draft-sync`**, **`send-reply`** job queues consumed inside the Gateway process. |
| **Celery (Redis broker)** | `LPUSH` of Celery protocol JSON envelopes | **`triage-queue`**, **`draft-queue`**, **`profile-queue`** consumed by **`ai-engine` Celery workers**. |
| **Redis Pub/Sub** | `PUBLISH` / `SUBSCRIBE` channel `draftly:events` | AI engine → Gateway **real-time** notifications (WebSocket bridge). |

When reading logs, always identify **which subsystem** backs a queue.

---

## 2) Email sync triggers (what exists in code today)

### A) Automatic on first Gmail OAuth success

After tokens are saved, the callback handler enqueues **`gmail-sync`**:

```218:225:gateway/src/infrastructure/http/routes/connections.ts
    // Trigger initial sync
    const correlationId = (req as any).correlationId || 'manual';
    await enqueueGmailSync({
      connectionId: connection.id,
      userId,
      correlationId,
      maxResults: 20,
    });
```

### B) Manual sync API

Authenticated users call **`POST /api/v1/connections/:type/sync`** (same underlying `enqueueGmailSync`):

```254:276:gateway/src/infrastructure/http/routes/connections.ts
connectionsRouter.post('/:type/sync', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  ...
  const jobId = await enqueueGmailSync({
    connectionId: connection.id,
    userId,
    correlationId,
    maxResults: req.body?.maxResults || 20,
  });

  res.json({
    message: 'Sync job queued',
    jobId,
    connectionId: connection.id,
  });
});
```

### C) Scheduled “every morning” (or cron / Celery Beat)

**Not implemented.** The repo ships a `celery-beat` Docker service (`docker-compose.yml`), but `ai-engine/src/celery_app.py` defines **no `beat_schedule`**, and the Gateway starts **no** repeatable BullMQ cron worker for Gmail.

To add a daily sync you would typically:

1. Configure Celery Beat to call an admin HTTP endpoint **or**
2. Add a repeatable BullMQ job in Gateway startup **or**
3. Add `@celery_app.on_after_configure.connect` scheduling in Python.

Until one of those exists, **sync is OAuth-triggered plus manual `/sync`.**

---

## 3) What happens inside `gmail-sync` (still Gateway / BullMQ)

High-level algorithm (see full file `gateway/src/infrastructure/workers/gmail-sync.worker.ts`):

1. **Decrypt** Gmail tokens → `GmailAdapter`.
2. **`syncRecentThreads(maxResults)`** → Gmail API list + GET thread → Postgres `email_threads` / `email_messages`.
3. For each synced thread missing **`triage_results`**, enqueue **Celery triage**:

```121:126:gateway/src/infrastructure/workers/gmail-sync.worker.ts
          await celeryBridge.dispatchTriageTask({
            threadId: thread.id,
            userId,
            correlationId,
          });
```

4. If **`user_profiles` empty**, enqueue **`ai.profile.build`** on **`profile-queue`**.

Dedup behavior: **`enqueueGmailSync`** passes `jobId: gmail-sync-{connectionId}` so only **one concurrent sync job per Gmail connection**.

---

## 4) CeleryBridge (Gateway → Celery queues on Redis)

`gateway/src/infrastructure/workers/celery-bridge.ts` builds Celery-compatible JSON envelopes (`body` base64-encoded, etc.) and **`LPUSH`es** them onto Redis keys named after the Celery queues.

Example — triage dispatch:

```20:43:gateway/src/infrastructure/workers/celery-bridge.ts
  async dispatchTriageTask(params: {
    threadId: string;
    userId: string;
    correlationId: string;
  }): Promise<string> {
    const taskId = uuidv4();

    const message = this.buildCeleryMessage({
      taskId,
      taskName: 'ai.triage.classify',
      queue: 'triage-queue',
      args: [params.threadId, params.correlationId, params.userId],
      kwargs: {},
    });

    await this.publishToQueue('triage-queue', message);
```

Workers must subscribe to **`triage-queue`**, **`draft-queue`**, **`profile-queue`** (see `docker-compose.yml` `--queues=...` or your local celery command).

---

## 5) AI Engine — triage task → optional draft enqueue

`triage-queue` consumes **`ai.triage.classify`**. After persistence + event publish:

```41:49:ai-engine/src/tasks/triage_tasks.py
    # If it is a reply_needed, queue up drafting automatically
    if classification == 'reply_needed':
        app.send_task(
            "ai.draft.generate",
            args=[thread_id, correlation_id, user_id],
            queue="draft-queue"
        )
```

So **`draft-queue` may be populated by AI Engine**, not directly by Gateway, on the automated path.

The triage Celery routing is centralized in configuration:

```42:46:ai-engine/src/celery_app.py
    task_routes={
        "ai.triage.*": {"queue": "triage-queue"},
        "ai.draft.*": {"queue": "draft-queue"},
        "ai.profile.*": {"queue": "profile-queue"},
    },
```

---

## 6) AI Engine — draft generation task

Manual API path (**Gateway**) can also kick drafts without waiting for `reply_needed` classification — see `POST …/threads/:id/draft` in `connections.ts`, which constructs `CeleryBridge` + `dispatchDraftTask` (same **`draft-queue`**, **`ai.draft.generate`**).

The **`ai.draft.generate`** task wraps `create_draft_pipeline()` (`ai-engine/src/pipelines/draft_pipeline.py`): load thread messages, persona from `user_profiles`, call LLM, insert **`drafts`** row (`status='generated'`, duplicate content in `generated_content` + `current_content`).

On success:

```31:39:ai-engine/src/tasks/draft_tasks.py
    await publish_event("draft_generated", {
        "userId": user_id,
        "threadId": thread_id,
        "correlationId": correlation_id,
        "draftId": draft_id,
        "status": "generated"
    })

    return {"draft_id": draft_id, "thread_id": thread_id}
```

Publisher:

```11:27:ai-engine/src/infrastructure/redis/event_publisher.py
    async def publish(self, event_type: str, payload: dict[str, Any]):
        channel = "draftly:events"
        message = {
            "type": event_type,
            "data": payload
        }
```

---

## 7) Gateway again — subscriber → **`draft-sync` BullMQ** (not Celery)

`gateway/src/infrastructure/redis/events.ts` subscribes to **`draftly:events`** on a duplicated Redis connection. On **`draft_generated`**, it enqueues **`draft-sync`** BullMQ worker with **`action: 'create'`** so Gmail receives a mirrored draft (`external_draft_id` persisted later):

```41:51:gateway/src/infrastructure/redis/events.ts
      if (type === 'draft_generated' && data.draftId && data.threadId) {
        await enqueueDraftSync({
          draftId: data.draftId,
          threadId: data.threadId,
          userId: data.userId,
          correlationId: data.correlationId || `draft-sync-${data.draftId}`,
          action: 'create',
        });
        logger.info({ draftId: data.draftId }, 'Enqueued Gmail draft sync from draft_generated event');
      }
```

`draft-sync` worker reads the draft row, composes MIME via `GmailAdapter.createGmailDraft`, then updates Postgres:

```146:154:gateway/src/infrastructure/workers/draft-sync.worker.ts
        await db('drafts').where({ id: draftId }).update({
          external_draft_id: externalDraftId,
          updated_at: new Date(),
        });
```

So the narrative “**Gateway → Redis (Celery) → AI → Redis Pub/Sub → Gateway → Redis (BullMQ) → Gmail**” is accurate — with **two** Redis patterns at play.

---

## 8) Complete pipeline diagram

```mermaid
flowchart TB
    subgraph GW["Gateway"]
        API["Express routes"]
        BS["BullMQ workers\n(gmail-sync, draft-sync, send-reply)"]
        CB["CeleryBridge\nLPUSH Celery envelopes"]
        SUB["RedisSubscriber\ndraftly:events"]
    end

    subgraph R["Redis"]
        BQ[BullMQ keys / metadata]
        CQ[Celery list queues:\ntriage, draft, profile]
        PS[draftly:events pub/sub]
    end

    subgraph AI["ai-engine-worker (Celery)"]
        T["ai.triage.classify"]
        D["ai.draft.generate"]
    end

    subgraph PG[(Postgres)]
    end

    subgraph GM[Gmail API]
    end

    API -->|enqueueGmailSync| BQ
    BS --> GM
    BS --> PG
    BS --> CB
    CB --> CQ
    CQ --> T
    T --> PG
    T -->|send_task reply_needed| D
    CQ --> D
    D --> PG
    D --> PS
    SUB --> PS
    SUB -->|enqueueDraftSync| BQ
    BS --> GM
```

---

## 9) Related user actions beyond auto-draft

See `connections.ts` for:

| Action | Approximate Gateway path | Downstream queues |
|--------|---------------------------|-------------------|
| Manually regenerate draft | `POST …/threads/:id/draft` | Celery **`draft-queue`** |
| Edit draft locally | `PUT …/draft` | Optionally **`draft-sync`** `update` if `external_draft_id` exists |
| Approve & send | `POST …/approve` | **`send-reply`** BullMQ |

---

## 10) Takeaways for debugging sync vs drafts

| Question | Fact from code |
|----------|----------------|
| Runs without user firing `/sync`? | Only automatically right after Gmail OAuth callback. |
| Periodic morning sync in repo today? | **No** Celery Beat schedule + **no** BullMQ repeatables. |
| Where does Celery consume from? | `triage-queue`, `draft-queue`, `profile-queue` on Redis. |
| Where does Gmail draft mirror happen? | `draft_generated` Redis event → **`draft-sync` BullMQ** in Gateway process. |

For general triage, see [04-debugging-playbook.md](./04-debugging-playbook.md).
