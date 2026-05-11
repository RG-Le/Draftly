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
├── main.py                           # FastAPI app (health endpoint)
├── celery_app.py                     # Celery configuration + task discovery
├── __init__.py
│
├── config/
│   ├── __init__.py
│   ├── settings.py                   # Pydantic Settings from env
│   ├── database.py                   # SQLAlchemy async engine + session factory
│   └── triage_categories.json        # Triage classification categories config
│
├── infrastructure/
│   ├── database/
│   │   └── models.py                 # SQLAlchemy ORM models (User, EmailThread, Draft, etc.)
│   ├── llm/
│   │   ├── llm_service.py            # LLMService (LiteLLM wrapper with primary/fallback)
│   │   └── prompt_manager.py         # PromptManager (Redis cache → DB → code fallback)
│   └── redis/
│       ├── connection.py             # Redis async connection
│       └── event_publisher.py        # Redis pub/sub event publisher
│
├── pipelines/                        # Composable workflow pipelines
│   ├── __init__.py
│   ├── base.py                       # Pipeline, Stage, PipelineContext, UsageAccumulator
│   ├── triage_pipeline.py            # Triage pipeline (single + batch)
│   ├── draft_pipeline.py             # Draft generation pipeline
│   └── profile_pipeline.py           # Profile analysis pipeline
│
└── tasks/                            # Celery task definitions
    ├── __init__.py
    ├── triage_tasks.py               # ai.triage.classify, ai.triage.classify_batch
    ├── draft_tasks.py                # ai.draft.generate
    └── profile_tasks.py              # ai.profile.build
```

> **Note:** The implementation uses a flat pipeline structure (one file per pipeline) rather than subdirectories. DB access is done inline within pipeline stages using SQLAlchemy ORM, not through separate repository classes. Prompt management uses a `PromptManager` class with Redis caching and DB fallback rather than Jinja2 template files.

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

The triage pipeline supports both single-thread and batch classification modes.

### Single-Thread Pipeline

```
LoadThreadContext → HeuristicPreFilter → LLMClassification → StoreResult
```

### Batch Pipeline (primary mode, triggered after sync)

```
LoadBatchThreads → HeuristicPreFilter → BatchLLMClassification → StoreBatchResults → EnqueueDraftsForReplyNeeded
```

### Stages

**1. LoadThreadContextStage** — Reads thread + latest message from DB. Extracts: subject, from_address, body text.

**2. HeuristicPreFilterStage** — Fast no-reply detection:
- Sender matches `no-reply`, `noreply`, `do-not-reply` patterns → classified as `info` with confidence 1.0, `should_stop = True`
- All other threads proceed to LLM classification.

**3. LLMClassificationStage** — Calls LLM with structured output (Pydantic `TriageResponse` model). Returns JSON with `classification`, `confidence`, and `reasoning`. Uses `generate_structured()` for type-safe responses.

**4. BatchLLMClassificationStage** — Processes multiple threads in a single LLM call. Builds a numbered list of emails and requests a `BatchTriageResponse` with results array. Falls back to individual classification if batch parsing fails.

**5. StoreTriageResultStage** — Upserts result to `triage_results` table using `ON CONFLICT DO NOTHING`. Records LLM metadata (model, tokens, cost).

**6. EnqueueDraftIfNeededStage** — If classification is `reply_needed`, publishes a `triage:completed` event and the calling task enqueues a draft generation task.

### Triage Categories (from `triage_categories.json`)

Categories are externalized to a JSON config file, not hardcoded:
- `reply_needed` — Requires a response from the user
- `promotions` — Marketing, newsletters, deals
- `info` — Informational notifications, no response needed
- `junk` — Spam or irrelevant content
- Default fallback: `info`

### Batch Optimization

After Gmail sync, unclassified threads are dispatched in batches (configurable via `TRIAGE_BATCH_SIZE`, default 25). This reduces LLM calls significantly — one call classifies up to 25 threads instead of 25 separate calls.

---

## Draft Generation Pipeline

```
LoadThreadHistory → LoadUserProfile → FormatContext → GenerateDraft → StoreDraft
```

### Stages

**1. LoadThreadHistoryStage** — Loads all messages for the thread, ordered chronologically.

**2. LoadUserProfileStage** — Reads the user's personalized communication profile from `user_profiles` table.

**3. FormatContextStage** — Formats messages into a readable chronological context block for the LLM. Truncates to last 6000 characters for extremely long threads.

**4. GenerateDraftStage** — Calls LLM via `PromptManager` to load the draft prompt template, then generates the reply using thread context and user profile. Uses the `draft_v1` prompt template.

**5. StoreDraftStage** — Writes to `drafts` table with status `generated`, stores generation metadata (model, tokens, cost). Uses `ON CONFLICT` to handle re-generation gracefully.

After storage, the task publishes a `draft:ready` event via Redis pub/sub for real-time WebSocket notification.

---

## Profile Update Pipeline

```
LoadSentEmails → FormatSentEmails → LLMProfileGeneration → SaveProfile
```

Triggered after first Gmail sync (if profile hasn't been calibrated) or on-demand.

**1. LoadSentEmailsStage** — Loads the last 20 emails sent by the user (joins through `user_connections` → `email_threads` → `email_messages` where `is_sent_by_user = True`). If no sent emails found, marks as cold start.

**2. FormatSentEmailsStage** — Formats sent messages into analysis blocks (subject + body). Filters out emails with fewer than 5 words. If no valid text remains, falls back to cold start.

**3. LLMProfileGenerationStage** — For cold starts, applies a professional default profile (greeting style, closing style, tone, communication norms, confidence 0.5). For users with sent emails, calls LLM to analyze writing style and extract structured profile data using `ProfileResponse` Pydantic model.

**4. SaveProfileStage** — Upserts profile to `user_profiles` table using `ON CONFLICT DO UPDATE`. Increments `profile_version` on updates. Sets `last_calibrated_at` only for non-cold-start profiles.

### Profile Bootstrap on Gmail Connection

When a user first connects Gmail, the gateway creates a default profile immediately (without waiting for LLM analysis):
- `preferred_tone`: "professional"
- `personalized_profile`: Default professional writing guidelines
- `signature_template`: User's name
- Default greeting/closing styles

The full LLM-based profile calibration runs asynchronously after the initial sync completes.

---

## LLM Service

```python
class LLMService:
    primary_model: str     # "gemini/gemini-2.0-flash" (from LLM_PRIMARY_MODEL env)
    fallback_model: str    # "gemini/gemini-1.5-flash" (from LLM_FALLBACK_MODEL env)
```

**Provider compatibility:**
- **Gemini** (direct, free tier): For development and as fallback. Model string: `gemini/gemini-2.0-flash`
- **OpenRouter**: When API key is available. Model string: `openrouter/google/gemini-2.0-flash`
- **OpenAI-compatible**: Supports custom `OPENAI_API_KEY` + `OPENAI_BASE_URL` for any OpenAI-compatible provider
- LiteLLM handles routing to the correct provider based on model string prefix.

**Fallback strategy:**
- Primary model fails → try fallback model
- Fallback model fails → mock fallback (returns safe default responses with zero cost)
- Mock fallback for triage returns `reply_needed` with 0.9 confidence
- Mock fallback for drafts returns an error message explaining LLM unavailability

**Methods:**
- `generate(system_prompt, user_prompt)` — Unstructured text generation (used for drafts)
- `generate_structured(system_prompt, user_prompt, response_format)` — Structured JSON output using Pydantic models (used for triage and profile)

**Cost calculation:**
- LiteLLM's `cost_calculator.completion_cost()` computes cost from response metadata
- If cost calculation fails, defaults to $0.00
- Metrics (model, input_tokens, output_tokens, cost) returned with every call

> **Note:** The documented circuit breaker pattern is not yet implemented. The current fallback strategy (primary → fallback → mock) provides resilience without formal circuit breaker state tracking.

---

## Celery Task Configuration

```python
# Triage task (single thread)
@celery_app.task(
    name='ai.triage.classify',
    queue='triage-queue',
    max_retries=2,
    default_retry_delay=5,
    acks_late=True,
    reject_on_worker_lost=True,
    time_limit=60,
    soft_time_limit=50,
)

# Batch triage task (multiple threads in one LLM call)
@celery_app.task(
    name='ai.triage.classify_batch',
    queue='triage-queue',
    max_retries=2,
    default_retry_delay=5,
    acks_late=True,
    reject_on_worker_lost=True,
    time_limit=120,
    soft_time_limit=100,
)

# Draft task
@celery_app.task(
    name='ai.draft.generate',
    queue='draft-queue',
    max_retries=2,
    default_retry_delay=10,
    acks_late=True,
    reject_on_worker_lost=True,
    time_limit=90,
    soft_time_limit=75,
)

# Profile build task
@celery_app.task(
    name='ai.profile.build',
    queue='profile-queue',
    max_retries=2,
    default_retry_delay=5,
    acks_late=True,
    reject_on_worker_lost=True,
    time_limit=60,
    soft_time_limit=50,
)
```

### Task Flow

- After Gmail sync completes, unclassified threads are dispatched as batch triage tasks
- After triage classifies a thread as `reply_needed`, a draft generation task is automatically enqueued
- After first Gmail connection (if profile not calibrated), a profile build task is dispatched
- All tasks reset DB engine and Redis connections on each invocation to avoid stale connections in forked Celery workers

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
