# Draftly — Limitations & Known Issues

This document tracks known functionality limitations, edge cases, and design trade-offs in the current implementation. Items are grouped by area. Each entry includes the root cause, current behavior, and whether a fix is planned.

---

## 1. Triage Pipeline

### 1.1 `already_replied` vs Native Gmail Draft Conflation *(Fixed in v019)*

**Status:** ✅ Fixed (Migration `019_add_is_draft_to_email_messages.ts`)

**Root cause:** The Gmail API returns all messages in a thread including native drafts. Before the fix, the `GmailAdapter` stored drafts as regular messages with `is_sent_by_user = true` (since they appeared from the user's address). The triage heuristic saw a "sent" message after the last incoming mail and incorrectly classified the thread as `already_replied`.

**Fix applied:**
- Added `is_draft` boolean column to `email_messages` (set using the Gmail `DRAFT` label).
- Added `CheckDraftInProgressStage` to the single-thread pipeline.
- Added draft heuristic to `BatchLLMTriageStage`.
- Threads with native Gmail drafts are now classified as `draft_in_progress` with 100% confidence, no LLM call.

---

### 1.2 Multi-party Reply Chains — Classification Accuracy

**Status:** ✅ Confirmed Working (no fix needed)

**Scenario:** `A → user replies → A replies → B replies (addressing user again) → someone else replies`

**How it works:** `CheckUserRepliedStage` tracks only messages where the user is in the `To` field as the last incoming message. It compares that timestamp against the user's last sent reply. If anyone replies after the user's last sent message and that reply is addressed to the user, the heuristic correctly does NOT fire `already_replied`. The thread falls through to the LLM which classifies it as `reply_needed`.

**Known edge case:** If the user is CC'd (not To'd) in the last incoming message, the heuristic will not detect it as an incoming message to the user. The LLM prompt will be given the full thread and should correctly classify it, but the heuristic's reply-check step may miss the CC signal.

---

### 1.3 CC-only Threading (Triage Heuristic Gap)

**Status:** ⚠️ Limitation

**Root cause:** `CheckUserRepliedStage` only looks at messages where the user is in the `To` field. It does not check `cc_addresses`. If someone sends a thread reply **only CC-ing** the user (not To), the heuristic assumes the user has not been directly addressed and falls through to the LLM.

**Impact:** Low. The LLM will still classify the thread correctly given the full context. The only risk is a slight prompt inflation (no heuristic short-circuit), which wastes a small number of tokens.

**Fix (when needed):** Extend `incoming_to_user` detection in `CheckUserRepliedStage` to also check `cc_addresses`.

---

### 1.4 Triage Stale After Reply is Sent

**Status:** ⚠️ Limitation

**Root cause:** Once a draft is approved and sent, the triage result is not automatically updated. A thread classified as `reply_needed` will remain `reply_needed` in the UI until the next sync + re-triage.

**Impact:** Medium. The inbox will show a "Reply Needed" tag for a thread the user has just replied to, until the next sync cycle picks up the new sent message and re-triage is triggered.

**Fix (when needed):** After a successful send, programmatically re-classify the thread as `already_replied` directly in the Gateway (`POST /connections/:type/threads/:id/triage`).

---

### 1.5 Batch Triage `thread_messages` Variable Scope Bug

**Status:** ⚠️ Known Edge Case

**Root cause:** In `BatchLLMTriageStage`, the draft check (`has_draft = any(msg.is_draft for msg in thread_messages)`) references `thread_messages` which is only set inside the `if user_email_lower:` block. If `user_email_lower` is `None`, `thread_messages` may be undefined when the draft check runs.

**Impact:** Low. Users always have an email address. Only affects edge cases where a user record exists without an email, which should not occur in normal flow.

**Fix (when needed):** Hoist `thread_messages = data.get("messages", [])` out of the `user_email_lower` block to the top of the per-thread loop.

---

## 2. Worker & Infrastructure

### 2.1 Celery Worker `SIGKILL` on Cloud Run (CPU Throttled Instances)

**Status:** ✅ Fixed (Cloud Run deployment configuration)

**Root cause:** Google Cloud Run's default billing model throttles the container's CPU to near-zero when no HTTP requests are being served. Celery workers run continuously in the background without serving HTTP, so the CPU throttling caused tasks to freeze and eventually receive `SIGKILL` from the Cloud Run runtime.

**Fix applied:**
- Deploy AI Worker with `--no-cpu-throttling` (`CPU is always allocated`).
- Set `--min-instances=0` so the container scales to zero when idle (cost-neutral when no jobs are queued).
- Set `--max-instances=2` to bound cost.

---

### 2.2 Scale-to-Zero Cold Start Latency

**Status:** ✅ Mitigated (Wakeup Ping Protocol)

**Root cause:** With `min-instances=0`, the AI Worker container is frozen when no tasks are queued. The first task after an idle period faces a ~2–5 second cold start before Celery can begin processing.

**Fix applied:** Gateway's `CeleryBridge` sends a lightweight `GET /ping` to the AI Engine immediately after every Redis `LPUSH`. This wakes the container concurrently with the Celery task arriving in the queue, minimising perceived latency.

**Remaining limitation:** The ping is fire-and-forget. If the container takes longer than expected to boot (e.g., during high GCP load), the Celery task may be picked up before the FastAPI server is fully ready. Celery's built-in `max_retries=2` handles this gracefully.

---

### 2.3 Duplicate Triage Job Dispatch (No Deduplication on Batch Dispatch)

**Status:** ⚠️ Known Issue

**Root cause:** After Gmail sync, the Gateway collects unclassified thread IDs and dispatches them as a batch triage job. If two sync operations complete in quick succession (e.g., a manual sync fires while an automatic sync is already running), two batch triage jobs may be dispatched for overlapping sets of thread IDs.

**Impact:** Low in practice due to the distributed Redlock sync lock. However, the Redlock only prevents concurrent *syncs*, not concurrent triage dispatches triggered by different sync completions.

**Current mitigation:** `SaveBatchTriageResultsStage` uses `ON CONFLICT DO UPDATE`, so duplicate classification of the same thread is idempotent (the later result simply overwrites the earlier one).

**Fix (when needed):** Maintain a Redis set of "triage-in-flight" thread IDs. Only dispatch threads not already in this set.

---

### 2.4 Draft Generation Triggered Despite `draft_in_progress`

**Status:** ⚠️ Known Limitation

**Root cause:** When a thread is re-classified from `already_replied` → `reply_needed` (before the draft fix), the Gateway may auto-dispatch a draft generation task. With the new `draft_in_progress` classification, the auto-draft dispatch logic in the sync worker checks for `reply_needed` before dispatching, so it will NOT dispatch a draft for `draft_in_progress` threads.

**Impact:** Zero for new syncs. For threads that were already incorrectly classified and had AI drafts generated, those drafts remain in the `drafts` table. Clearing them requires manual DB intervention or a UI "Reject" action.

---

## 3. Gmail Sync

### 3.1 Metadata-First Sync (No Body at Triage Time)

**Status:** ℹ️ By Design

The Gmail sync uses `format: 'metadata'` to fetch thread lists quickly without downloading full email bodies. This means:
- The triage LLM only sees `From`, `Subject`, `CC` flag, and `BCC` flag — **not the email body**.
- Draft generation requires a separate `fetchThreadFull()` call to fetch the body before dispatching the Celery task.

**Impact:** The LLM cannot use email body content for triage. Classification is based on headers only. This may cause misclassification for emails with generic subjects but meaningful body content (e.g., `Subject: Hello` with an urgent request in the body).

**Fix (when needed):** Fetch full body for a sample of threads (e.g., the last 2 messages in each thread) at sync time. Trade-off: significantly higher Gmail API quota usage.

---

### 3.2 Draft Body Not Fetched at Sync Time

**Status:** ℹ️ By Design

Native Gmail drafts are stored with `body_text = null` and `body_html = null` in the `email_messages` table (metadata-first sync). The draft content is only fetchable on-demand.

**Impact:** The Draft Workspace in the UI shows the AI-generated draft, not the native Gmail draft text. If the user had already typed content in the native Gmail draft, Draftly does not import or display it.

**Fix (when needed):** When `is_draft = true`, perform an on-demand `fetchThreadFull()` to populate the body and display it in the timeline.

---

## 4. Frontend & UX

### 4.1 Triage Tag Not Updated Immediately After Send

**Status:** ⚠️ Known UX Gap (see §1.4)

After the user clicks "Approve & Queue Send", the thread tag in the Inbox Review Queue still shows `Reply Needed` until the next sync and re-triage cycle. There is no optimistic UI update.

---

### 4.2 Native Gmail Draft Shown in Message Timeline Without Markup

**Status:** ⚠️ Known UX Gap

Messages with `is_draft = true` are rendered in the Message Timeline alongside sent/received emails without any visual distinction (no "Draft" badge, no different background colour). This can be confusing if the draft text is visible.

**Fix (when needed):** Add `isDraft` to the API response for `GET /connections/:type/threads/:id`. In the frontend `MessageTimeline` component, render `is_draft = true` messages with a yellow "Draft" badge.

---

### 4.3 No Pagination on Message Timeline

**Status:** ℹ️ By Design for Now

The thread detail view loads all messages for a thread at once. For very long threads (50+ messages), this could be slow.

---

## 5. Profile Pipeline

### 5.1 Profile Not Re-calibrated on Each Send

**Status:** ℹ️ By Design

The profile pipeline is triggered once after the first Gmail connection and on-demand via `POST /api/v1/profile/regenerate`. It is NOT automatically re-triggered after each approved send. This means the profile may lag behind the user's most recent writing style.

---

### 5.2 Cold Start Profile Uses Static Default

**Status:** ℹ️ By Design

Users with no sent emails (new Gmail accounts or fresh OAuth connections) receive a hardcoded "professional" default profile. The AI profile calibration only runs after at least one sent email is found.

---

## 6. Security

### 6.1 Token Refresh Not Retry-Safe on Concurrent Requests

**Status:** ⚠️ Known Race Condition

If two concurrent API requests arrive and both trigger a token refresh (because the access token just expired), both may call the Google OAuth token endpoint simultaneously and store conflicting results.

**Current mitigation:** The encrypted token update is an atomic DB write. One write will win; the other may store a stale token.

**Fix (when needed):** Add a per-user Redis lock on the token refresh operation, or use `SELECT FOR UPDATE` on the connection row during refresh.

---

## Summary Table

| # | Area | Issue | Severity | Status |
|---|------|-------|----------|--------|
| 1.1 | Triage | Native draft misclassified as `already_replied` | High | ✅ Fixed |
| 1.2 | Triage | Multi-party reply chains | Medium | ✅ Working |
| 1.3 | Triage | CC-only threads miss heuristic | Low | ⚠️ Limitation |
| 1.4 | Triage | Stale tag after send | Medium | ⚠️ Limitation |
| 1.5 | Triage | Batch `thread_messages` scope | Low | ⚠️ Edge Case |
| 2.1 | Worker | Celery SIGKILL on Cloud Run | Critical | ✅ Fixed |
| 2.2 | Worker | Scale-to-zero cold start | Medium | ✅ Mitigated |
| 2.3 | Worker | Duplicate triage dispatch | Low | ⚠️ Known |
| 2.4 | Worker | Draft gen on draft_in_progress | Low | ⚠️ Limitation |
| 3.1 | Sync | No body at triage time | Medium | ℹ️ By Design |
| 3.2 | Sync | Draft body not fetched | Low | ℹ️ By Design |
| 4.1 | Frontend | Tag not updated post-send | Medium | ⚠️ UX Gap |
| 4.2 | Frontend | Draft not badged in timeline | Low | ⚠️ UX Gap |
| 4.3 | Frontend | No timeline pagination | Low | ℹ️ By Design |
| 5.1 | Profile | Not re-calibrated on send | Low | ℹ️ By Design |
| 5.2 | Profile | Cold start uses static default | Low | ℹ️ By Design |
| 6.1 | Security | Token refresh race condition | Medium | ⚠️ Known |
