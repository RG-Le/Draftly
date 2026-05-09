# Extensibility Framework — Detailed Design

## The Core Question

How does Draftly go from "AI email reply tool" to a platform that supports:
- Email classification dashboards
- Morning email digests
- Evening newsletter summaries
- Google Calendar-aware replies
- Jira ticket email bridges
- Any future workflow composing external services + AI

---

## Architecture: Workflow-First with Connector Registry

### Why NOT Adapter Pattern

The Adapter Pattern wraps each external service behind a common interface (`IEmailAdapter`, `ICalendarAdapter`). It answers: "How do I swap Gmail for Outlook?"

But that's not Draftly's extensibility question. Draftly's question is: "How do I add a Morning Digest feature without touching existing email reply code?"

The Adapter Pattern doesn't compose workflows. It abstracts individual services. You still need to wire together sync, AI, scheduling, and delivery for each new use case manually.

### Why NOT Plugin System

A full plugin system (like VSCode or n8n) lets you dynamically register, load, and unload plugins at runtime.

This is overkill. Draftly doesn't need runtime plugin discovery or hot-reloading. It needs a clean way for developers to add new use cases to the codebase. Static composition is fine.

Building a plugin framework is a project in itself. We'd be building infrastructure instead of product.

### What Workflow-First Means

Three concepts:

1. **Connectors** — Configuration for external services. Not abstract interfaces. Just: "Gmail is available, here's how to reach it, here are its quotas."

2. **Workflows** — The actual extensibility unit. Each user-facing feature is a workflow composed of pipeline stages. Workflows are Python classes, not YAML or dynamic config.

3. **Stages** — Reusable building blocks. A stage does one thing (load thread context, call LLM, store result). Stages are shared across workflows.

---

## Connectors

### What a Connector is

A connector is a **configuration record** that tells the system an external service exists and how to interact with it.

```typescript
// Node.js Gateway — ConnectorRegistry
interface ConnectorConfig {
  name: string;                    // 'gmail', 'google-calendar', 'jira'
  displayName: string;             // 'Gmail', 'Google Calendar', 'Jira'
  authType: 'oauth2' | 'api-key';
  scopes?: string[];               // OAuth scopes needed
  quotaLimits?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  healthEndpoint?: string;
  isEnabled: boolean;
}
```

### What a Connector is NOT

- Not an abstract interface with methods like `fetchData()` or `sendMessage()`
- Not a plugin that registers routes and jobs
- Not a factory pattern

### Why this is better than abstract adapters

The Gmail API and Jira API have nothing in common functionally. Forcing them behind `IServiceAdapter.fetchData()` creates a useless interface that either:
- Is so generic it's meaningless (`fetchData(params: any): any`)
- Or is so specific it only works for one service

Instead, we have concrete services: `GmailSyncService`, `GmailSendService`, `JiraTicketService`. They're structured clearly, typed specifically, and testable directly.

The Connector Registry just tracks which services are configured and healthy. That's all it needs to do.

---

## Workflows

### What a Workflow Is

A workflow is a **named sequence of pipeline stages** that accomplishes a user-facing goal. It's defined in Python and executed by Celery workers.

### Current Workflow: Email Reply

```
EmailReplyWorkflow
├── Triage Pipeline:    LoadContext → Heuristic → LLM (if needed) → StoreResult → EnqueueDraft
├── Draft Pipeline:     LoadContext → LoadProfile → AssemblePrompt → Generate → Validate → Store → Notify
└── Profile Pipeline:   LoadDraft → LoadProfile → Evaluate → ApplyUpdate
```

### Future Workflow Examples

**Morning Digest** (new workflow, reuses existing stages):

```python
class MorningDigestWorkflow:
    name = "morning-digest"
    schedule = "0 7 * * *"          # 7 AM daily
    required_connectors = ["gmail"]
    
    pipeline = Pipeline("morning-digest", [
        FetchRecentThreadsStage(),   # Reuses thread query logic
        FilterUnprocessedStage(),    # New stage
        SummarizeThreadsStage(),     # New LLM stage with digest prompt
        ComposeDigestStage(),        # New stage
        DeliverDigestStage(),        # Email or push notification
        RecordUsageStage(),          # REUSED from email-reply
    ])
```

**Calendar-Aware Reply** (extends existing workflow):

```python
class CalendarAwareReplyWorkflow:
    name = "calendar-reply"
    required_connectors = ["gmail", "google-calendar"]
    
    triage_pipeline = Pipeline("triage", [
        LoadThreadContextStage(),       # REUSED
        HeuristicClassificationStage(), # REUSED
        LLMClassificationStage(),       # REUSED
        StoreTriageResultStage(),       # REUSED
    ])
    
    draft_pipeline = Pipeline("calendar-draft", [
        LoadThreadContextStage(),       # REUSED
        LoadUserProfileStage(),         # REUSED
        FetchCalendarContextStage(),    # NEW — gets meetings with thread participants
        AssembleCalendarPromptStage(),   # NEW — enriches prompt with calendar data
        GenerateDraftStage(),           # REUSED (same LLM call, different prompt)
        ValidateDraftStage(),           # REUSED
        StoreDraftStage(),              # REUSED
        NotifyDraftReadyStage(),        # REUSED
        RecordUsageStage(),             # REUSED
    ])
```

### Adding a New Workflow — Step by Step

1. **Define the workflow class** in `ai-engine/src/pipelines/your_workflow/`
2. **Create new stages** (only for logic that doesn't exist yet)
3. **Reuse existing stages** (import from shared/other pipelines)
4. **Add Celery tasks** in `ai-engine/src/tasks/your_workflow_tasks.py`
5. **Register the connector** (if using a new external service) in Node's ConnectorRegistry
6. **Add API routes** (if the workflow has user-facing actions) in the Node gateway
7. **Add prompts** (if the workflow uses LLM) in `ai-engine/src/prompts/your_workflow/`

**What you DON'T touch:**
- Existing workflow code
- Existing pipeline stages (you import them)
- Database migration (unless you need new tables for new data types)
- Inter-service communication (same Redis queues, same pub/sub)

---

## Stages — The Reusable Building Blocks

### Design Rules for Stages

1. **Single responsibility** — One stage does one thing.
2. **Stateless** — All data flows through `PipelineContext`. No instance state.
3. **Idempotent** — Running a stage twice with the same input produces the same result.
4. **Independent** — A stage doesn't know what came before or after it. It reads from and writes to the context.
5. **Testable** — Mock the context, run the stage, assert the output.

### Shared Stages (reusable across workflows)

| Stage | What it does | Used by |
|-------|-------------|---------|
| `LoadThreadContextStage` | Reads thread + messages from DB | Triage, Draft, Calendar-draft |
| `LoadUserProfileStage` | Reads profile + preferences | Draft, Calendar-draft, Digest |
| `GenerateDraftStage` | Calls LLM with assembled prompt | Draft, Calendar-draft |
| `ValidateDraftStage` | Checks draft quality | Draft, Calendar-draft |
| `StoreDraftStage` | Writes draft to DB | Draft, Calendar-draft |
| `NotifyDraftReadyStage` | Publishes Redis pub/sub event | Draft, Calendar-draft |
| `RecordUsageStage` | Records LLM tokens + cost | All workflows |

### Workflow-Specific Stages

Each workflow adds stages for its unique logic. These live in the workflow's directory, not in shared.

---

## Future Extensibility Map

| Capability | Connectors Needed | New Stages | Reused Stages | Timeline |
|-----------|-------------------|------------|---------------|----------|
| Email Reply | Gmail | Triage (heuristic + LLM), Draft generation, Profile update | — | Capstone ✅ |
| Email Classification Dashboard | Gmail | Classification aggregation, Dashboard data | LoadThreadContext, LLM Classification | Post-capstone |
| Morning Digest | Gmail | FetchRecent, Summarize, ComposeDigest, Deliver | RecordUsage | Post-capstone |
| Evening Newsletter | Gmail | FetchToday, CurateNews, ComposeNewsletter | RecordUsage | Post-capstone |
| Calendar-Aware Reply | Gmail, Google Calendar | FetchCalendarContext, AssembleCalendarPrompt | Full triage pipeline, GenerateDraft, ValidateDraft, StoreDraft | Post-capstone |
| Meeting Follow-up | Google Calendar, Gmail | FetchMeetingNotes, GenerateFollowUp | LoadProfile, GenerateDraft | Post-capstone |
| Jira Email Bridge | Gmail, Jira | ExtractJiraContext, MapToTicket | LoadThreadContext | Post-capstone |

---

## What This Framework Cannot Do

Be honest about limits:

- **No hot-reloading** — Adding a workflow requires code changes and a deploy. This is acceptable for a product with a development team. Not acceptable for a no-code platform.
- **No UI-driven workflow builder** — Workflows are Python classes, not drag-and-drop. Building a visual workflow builder is a separate product.
- **No cross-workflow orchestration** — Workflows are independent. If Morning Digest needs to trigger Email Reply, they communicate through the database and queue, not direct calls. This is by design (isolation) but adds latency.
- **Stage dependencies are implicit** — A stage assumes certain data exists in the context. If you compose stages incorrectly, you get runtime errors, not compile-time errors. Mitigation: good documentation and stage-level validation.
