# Debugging Playbook

Use this when changes do not reflect, jobs stall, or data appears inconsistent.

---

## 1) First 5-Minute Triage

1. Check all expected processes are running:
   - gateway
   - ai-engine worker
   - ai-engine API (if using health endpoint)
   - docker infra (`postgres`, `pgbouncer`, `redis`)
2. Hit health endpoints:
   - `GET /api/v1/admin/health`
   - `GET /health`
3. Confirm env values loaded as expected:
   - DB host/port
   - Redis URL
   - OAuth callback URLs
   - API keys and encryption key

---

## 2) If API Works but AI Does Not Trigger

Symptoms:

- Threads sync, but no triage/drafts appear.

Checks:

- gateway logs from `gmail-sync.worker.ts` should show dispatch via `CeleryBridge`.
- Redis should have queue activity on `triage-queue` / `draft-queue`.
- Celery worker command must include all required queues:
  - `--queues=triage-queue,draft-queue,profile-queue`

Likely root causes:

- Celery worker not running
- queue name mismatch
- bad Redis URL

---

## 3) If AI Finishes but UI/WebSocket Gets No Updates

Checks:

- AI worker publishes to `draftly:events` in `event_publisher.py`.
- gateway subscriber `infrastructure/redis/events.ts` is active.
- event payload must include `type`, `data`, and `data.userId`.
- WebSocket auth/session mapping in `infrastructure/socket/websocket.ts`.

Likely root causes:

- malformed event payload
- subscriber not started
- user socket not connected/registered

---

## 4) If Drafts Exist in DB but Not in Gmail

Checks:

- `draft_generated` event should enqueue `draft-sync` action `create`.
- `draft-sync.worker.ts` needs valid Gmail connection + decrypted tokens.
- verify `drafts.external_draft_id` gets populated.

Likely root causes:

- revoked/expired Gmail token
- missing Gmail scopes
- draft-sync worker failure

---

## 5) If Approve/Send Fails

Checks:

- draft status must be `approved` before send worker processes.
- send worker should record rows in `send_attempts`.
- inspect `error_message` for Gmail API failures.

Likely root causes:

- stale/missing `external_draft_id`
- insufficient Gmail permissions
- wrong recipient extraction in thread message data

---

## 6) If DB Changes Do Not Reflect

Checks:

- run `npm run migrate` again from `gateway`.
- verify migration table (`knex_migrations`) has latest version.
- ensure migration connected to Postgres `5432` (not pooled transaction path).

Likely root causes:

- migration failed midway
- running app points to a different DB host/port

---

## 7) Where to Place Logs While Debugging

- gateway route layer: `infrastructure/http/routes/*`
- queue enqueue points: `infrastructure/workers/*.ts` enqueue functions
- queue processors: BullMQ `Worker` handlers
- celery task wrappers: `ai-engine/src/tasks/*`
- pipeline stages: `ai-engine/src/pipelines/*`

Tip:

- follow a single `correlationId` end-to-end across gateway logs, Celery task logs, and DB rows (`usage_records`, `audit_logs`).

---

## 8) Safe Change Workflow

1. Make small scoped edits in one layer first (route, worker, or pipeline).
2. Run only the needed service locally (faster feedback).
3. Verify with one known thread/user.
4. Confirm DB side effects.
5. Confirm event/WebSocket side effects.
6. Expand to next layer only after the first is stable.
