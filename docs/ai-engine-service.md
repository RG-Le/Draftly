# AI Engine Service (Python) — Detailed Design

## Role

All intelligence lives here. The AI Engine:
- Runs triage pipelines (heuristic + LLM)
- Generates drafts (context assembly → prompt → LLM → validation)
- Manages user profiles (analysis, bounded updates)
- Manages prompts (versioned Jinja2 templates)
- Routes LLM calls (OpenRouter / Gemini via LiteLLM)
- Tracks token usage and cost

It does **not** serve user-facing APIs (except health/admin). It does **not** touch Gmail directly. It does **not** handle authentication.

---

## Design Decisions

| Decision | Choice | Why | Risk |
|----------|--------|-----|------|
| FastAPI over Flask/Django | FastAPI | Async-first, auto OpenAPI docs, Pydantic validation built-in. Only serves health/admin endpoints — lightweight is correct. | FastAPI's ecosystem is younger than Flask. Not an issue since we're not building a full web app here. |
| Celery over Dramatiq/Huey | Celery | Industry standard Python task queue. Mature monitoring (Flower), retry/rate-limit/priority built-in. Horizontal scaling is trivial — add more workers. | Celery's codebase is large and can be opaque to debug. Its async support (celery[gevent]) works but isn't native asyncio. We use `asyncio` inside tasks via `asgiref.sync_to_async` where needed. |
| LiteLLM over raw HTTP/LangChain | LiteLLM | Provider-agnostic: OpenRouter, Gemini, OpenAI, Anthropic — all behind `litellm.completion()`. Handles retries, streaming, token counting. LangChain is too heavy (pulls 50+ transitive deps) for what we need. | LiteLLM is a third-party dependency. If it breaks, we're blocked. Mitigation: LiteLLM's API surface is small enough to replace with raw HTTP in a day. |
| SQLAlchemy 2.0 (async) over raw SQL | SQLAlchemy | Python workers need to read threads, profiles, and write triage/draft results. SQLAlchemy gives us a clean async session with connection pooling. We're NOT using the ORM layer — just Core (query builder). | Two query builders (Knex in Node, SQLAlchemy in Python) accessing the same DB. Schema must be kept in sync. Migrations run from Node (Knex) only — single source of truth. |
| Jinja2 for prompts over hardcoded strings | Jinja2 | Prompts are long, structured, and version-controlled. Jinja2 gives variable substitution, conditionals, and includes. Templates live in files, not buried in Python code. | Added complexity. For simple prompts, strings are fine. Our prompts have 10+ variables and conditional sections — Jinja2 earns its keep. |

---

## Internal Structure

```
ai-engine/src/
├── main.py                           # FastAPI app (health, admin, Flower redirect)
├── celery_app.py                     # Celery configuration + task discovery
│
├── config/
│   ├── settings.py                   # Pydantic Settings from env
│   └── database.py                   # SQLAlchemy async engine + session factory
│
├── domain/
│   ├── models.py                     # Pydantic models mirroring DB entities
│   └── enums.py                      # TriageClassification, DraftStatus
│
├── pipelines/                        # Composable workflow pipelines
│   ├── base.py                       # Pipeline, Stage, PipelineContext ABCs
│   ├── triage/                       # Triage pipeline stages
│   ├── draft/                        # Draft generation pipeline stages
│   └── profile/                      # Profile update pipeline stages
│
├── llm/
│   ├── router.py                     # LLMRouter (LiteLLM wrapper)
│   ├── circuit_breaker.py            # Circuit breaker for LLM calls
│   └── cost_calculator.py            # Cost estimation from token usage
│
├── prompts/                          # Jinja2 templates (versioned)
│   ├── triage/
│   ├── draft/
│   └── profile/
│
├── tasks/                            # Celery task definitions
│   ├── triage_tasks.py
│   ├── draft_tasks.py
│   └── profile_tasks.py
│
├── repositories/                     # DB access (SQLAlchemy Core)
│   ├── thread_repo.py
│   ├── draft_repo.py
│   ├── triage_repo.py
│   ├── profile_repo.py
│   └── usage_repo.py
│
└── shared/
    ├── logging.py                    # structlog configuration
    └── events.py                     # Redis pub/sub event publisher
```

---

## Pipeline Architecture

### What a Pipeline is

A pipeline is a sequence of stages. Each stage takes a context, does one thing, and returns the context (possibly modified). Pipelines are the unit of work.

```python
class PipelineContext:
    """Carries data through pipeline stages."""
    correlation_id: str
    user_id: str
    thread_id: str
    data: dict                      # Accumulated results from stages
    should_stop: bool = False       # Early exit signal
    errors: list[str] = []
    usage: UsageAccumulator         # Tracks tokens/cost across stages

class Stage(ABC):
    @abstractmethod
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        pass

class Pipeline:
    def __init__(self, name: str, stages: list[Stage]):
        self.name = name
        self.stages = stages

    async def execute(self, ctx: PipelineContext) -> PipelineContext:
        for stage in self.stages:
            ctx = await stage.process(ctx)
            if ctx.should_stop:
                break
        return ctx
```

### Why Pipelines (not plain functions)

| Concern | Plain Function | Pipeline |
|---------|---------------|----------|
| Reuse stages across workflows | Copy-paste | Import and compose |
| Per-stage logging/timing | Manual | Automatic (pipeline runner) |
| Error isolation | Try/catch spaghetti | Each stage is isolated |
| Testing | Mock everything | Test one stage at a time |
| Future workflow creation | Rewrite | Compose existing stages + new ones |

### When Pipelines are overkill
Single-step operations (health check, simple DB write). Don't pipeline trivial work.

---

## Triage Pipeline

```
LoadThreadContext → HeuristicClassification → (LLMClassification) → StoreResult → EnqueueDraftIfNeeded
```

### Stages

**1. LoadThreadContextStage** — Reads thread + messages from DB. Extracts: subject, from, to, cc, body preview, thread length.

**2. HeuristicClassificationStage** — Fast rules, no LLM call:
- User in `To` + message has `?` → likely `reply_needed`
- Sender matches `noreply@`, `notifications@` → `notification_or_subscription`
- User only in `Cc` → `cc_or_bulk_low_priority`
- No clear question or action → `informational_no_action`
- If confidence ≥ 0.8, mark `should_stop = True` (skip LLM).

**3. LLMClassificationStage** — Only runs if heuristic confidence < 0.8. Calls OpenRouter/Gemini with triage prompt. Returns structured JSON classification.

**4. StoreTriageResultStage** — Writes result to `triage_results` table. Records method (`heuristic`, `llm`, `hybrid`).

**5. EnqueueDraftIfNeededStage** — If `reply_needed`, enqueues a draft generation Celery task.

### Cost impact of hybrid triage
At 1000 users, ~3000 triage jobs/hour. If 60% resolve via heuristic, we save ~1800 LLM calls/hour. At ~$0.001/call, that's ~$1.80/hour saved. Over a month: ~$1300 saved.

---

## Draft Generation Pipeline

```
LoadContext → LoadProfile → AssemblePrompt → (SummarizeIfLong) → GenerateDraft → ValidateDraft → StoreDraft → NotifyReady → RecordUsage
```

### Stages

**1. LoadThreadContextStage** — Reused from triage pipeline.

**2. LoadUserProfileStage** — Reads profile (tone, greeting, closing, priorities) + preferences (signature) from DB.

**3. AssemblePromptStage** — Builds the structured LLM prompt using Jinja2 template. Injects: thread context, profile, signature, constraints.

**4. SummarizeThreadIfLongStage** — If thread > 10 messages or > 4000 tokens, summarize first. Reduces input tokens, saves cost.

**5. GenerateDraftStage** — Calls LLM via LiteLLM. Returns draft content.

**6. ValidateDraftStage** — Checks: non-empty response, no obvious hallucinations (mentions things not in thread), reasonable length, contains signature if configured.

**7. StoreDraftStage** — Writes to `drafts` table with status `draft_ready`, generation metadata (model, tokens, cost).

**8. NotifyDraftReadyStage** — Publishes `draft:ready` event to Redis pub/sub. Node Gateway picks this up and pushes via WebSocket.

**9. RecordUsageStage** — Writes to `usage_records` table: tokens used, model, estimated cost.

---

## Profile Update Pipeline

```
LoadApprovedDraft → LoadCurrentProfile → EvaluateUpdate → ApplyBoundedUpdate → RecordUsage
```

Triggered asynchronously after a draft is approved and sent. Low priority.

**EvaluateUpdateStage** — Asks LLM: "Given this approved reply and the current profile, should anything change?" Expected response: `no_change` or a structured patch (e.g., `{ "closing_style": "Best regards" }`).

**ApplyBoundedUpdateStage** — Only accepts bounded, structured fields. No free-text dumps. Increments `profile_version`. Profiles don't grow unbounded.

---

## LLM Router

```python
class LLMRouter:
    primary_model: str     # "gemini/gemini-2.0-flash" or "openrouter/google/gemini-2.0-flash"
    fallback_model: str    # "gemini/gemini-1.5-flash" (free tier)
    circuit_breaker: CircuitBreaker  # Open after 5 failures, recover after 60s
```

**Provider compatibility:**
- **Gemini** (direct, free tier): For development and as fallback. Model string: `gemini/gemini-2.0-flash`
- **OpenRouter**: When API key is available. Model string: `openrouter/google/gemini-2.0-flash`
- LiteLLM handles routing to the correct provider based on model string prefix.

**Circuit breaker:**
- Tracks failures per model
- After 5 consecutive failures → circuit opens → all calls go to fallback model
- After 60s → circuit half-opens → one probe request
- If probe succeeds → circuit closes → normal operation

**Cost calculation:**
- OpenRouter returns cost in response headers
- Gemini free tier: $0 (rate-limited to 15 RPM / 1M tokens/day)
- We store estimated cost per request for billing dashboard

---

## Celery Task Configuration

```python
# Triage task
@celery_app.task(
    name='ai.triage.classify',
    queue='triage-queue',
    max_retries=2,
    default_retry_delay=2,
    acks_late=True,                  # Don't ack until task completes
    reject_on_worker_lost=True,      # Re-queue if worker crashes
    time_limit=30,                   # Hard kill at 30s
    soft_time_limit=25,              # SoftTimeLimitExceeded at 25s
)

# Draft task
@celery_app.task(
    name='ai.draft.generate',
    queue='draft-queue',
    max_retries=3,
    default_retry_delay=10,
    acks_late=True,
    reject_on_worker_lost=True,
    time_limit=60,                   # Drafts can take longer (LLM latency)
    soft_time_limit=50,
    rate_limit='30/m',               # Max 30 drafts/minute
)

# Profile task
@celery_app.task(
    name='ai.profile.update',
    queue='profile-queue',
    max_retries=2,
    default_retry_delay=5,
    acks_late=True,
    time_limit=30,
    rate_limit='10/m',
)
```

---

## Implementation Priority

1. Celery app + Redis broker config
2. FastAPI health endpoint
3. SQLAlchemy async engine + session
4. Pipeline framework (base classes)
5. LLMRouter (LiteLLM + Gemini)
6. Prompt templates (triage v1, draft v1)
7. Triage pipeline + Celery task
8. Draft pipeline + Celery task
9. Redis pub/sub event publisher
10. Usage recording
11. Profile pipeline + Celery task
12. Circuit breaker
13. structlog configuration
