# Billing & Usage Tracking — Detailed Design

## Strategy

**Phase 1 (Capstone):** Track all costs. Display usage to users. No payment collection.
**Phase 2 (Product):** Stripe integration. Usage-based billing. Invoicing.

### Why track costs from day 1

1. You cannot price a product without knowing your unit economics.
2. LLM costs are unpredictable — per-user spend data prevents surprises.
3. Users seeing their usage builds trust and prepares them for paid tiers.
4. The `usage_records` table built in Phase 1 becomes the direct input for billing in Phase 2. No schema migration needed.

### Why NOT build billing in capstone

- Stripe integration is well-documented and takes 2-3 days.
- Building it before you have paying users is premature optimization.
- You don't know your pricing model yet — need usage data first.

---

## What We Track

| Resource | Tracked By | How | Cost Source |
|----------|-----------|-----|-------------|
| LLM input tokens | Python AI Engine | LiteLLM response metadata | OpenRouter/Gemini pricing |
| LLM output tokens | Python AI Engine | LiteLLM response metadata | OpenRouter/Gemini pricing |
| LLM requests count | Python AI Engine | Counter per pipeline stage | — |
| Gmail sync API calls | Node Gateway | Counter per sync job | Free (within quota) |
| Gmail send API calls | Node Gateway | Counter per send attempt | Free (within quota) |
| Drafts generated | Python AI Engine | Counter per draft pipeline | Included in LLM cost |
| Emails sent | Node Gateway | Counter per successful send | Free |

---

## Cost Calculation

### LLM Costs (primary cost driver)

**Gemini Free Tier:**
- 15 requests/min, 1M tokens/day, 1500 requests/day
- Cost: $0.00

**Gemini Paid (via OpenRouter or direct):**
- Gemini 2.0 Flash: ~$0.10 / 1M input tokens, ~$0.40 / 1M output tokens
- Gemini 1.5 Flash: ~$0.075 / 1M input tokens, ~$0.30 / 1M output tokens

**Estimated per-user monthly cost (active user, 10 drafts/day):**

| Operation | Calls/day | Avg tokens/call | Monthly tokens | Monthly cost |
|-----------|-----------|----------------|----------------|-------------|
| Triage (LLM path, ~40% of threads) | 12 | 800 | ~290k | ~$0.03 |
| Draft generation | 10 | 2500 | ~750k | ~$0.30 |
| Profile update | 3 | 1500 | ~135k | ~$0.05 |
| **Total per active user** | | | **~1.2M** | **~$0.38/month** |

At 600 active users: **~$228/month in LLM costs**.

This is manageable. The hybrid triage (heuristic saves ~60% of LLM calls) is the biggest cost saver.

---

## Usage Recording

### Where recording happens

**Python AI Engine** — LLM metadata is stored inline with each result:

- **Triage results**: `triage_results.llm_metadata` JSONB column stores `{ model, input_tokens, output_tokens, cost }`
- **Drafts**: `drafts.generation_metadata` JSONB column stores `{ model, input_tokens, output_tokens, cost }`

This approach avoids separate `usage_records` table writes on every operation while still enabling accurate aggregation.

**Node Gateway** — The usage endpoint (`GET /api/v1/usage`) aggregates costs directly from these JSONB columns:

```sql
-- Triage cost aggregation
SELECT 
  SUM(CAST(llm_metadata->>'cost' AS FLOAT)) as triage_cost,
  SUM(CAST(llm_metadata->>'input_tokens' AS INTEGER)) as triage_input,
  SUM(CAST(llm_metadata->>'output_tokens' AS INTEGER)) as triage_output
FROM triage_results ...

-- Draft cost aggregation  
SELECT
  SUM(CAST(generation_metadata->>'cost' AS FLOAT)) as draft_cost,
  SUM(CAST(generation_metadata->>'input_tokens' AS INTEGER)) as draft_input,
  SUM(CAST(generation_metadata->>'output_tokens' AS INTEGER)) as draft_output
FROM drafts ...
```

### Performance consideration

No separate usage table writes means zero additional DB pressure per LLM call. Aggregation queries run on-demand when the user views the usage page, with period filtering (7d/30d/90d/all) to keep query scope bounded.

---

## Usage Budget Enforcement

### Hourly LLM token budget

```
Per user: 50,000 tokens / hour
```

Tracked in Redis: `INCRBY llm_budget:{userId}:{hour} {tokenCount}`, with TTL of 3600s.

Checked before any LLM call. If exceeded, the pipeline stage fails gracefully with a budget error. The user sees: "Hourly AI usage limit reached. Resets in X minutes."

### Daily LLM token budget

```
Per user: 200,000 tokens / day
```

Tracked in DB: `SELECT SUM(quantity) FROM usage_records WHERE user_id = $1 AND usage_date = CURRENT_DATE AND resource_type LIKE 'llm_%'`.

Checked less frequently (cached in Redis for 5 minutes).

### Why budget limits even with free tier

- Prevents runaway costs if a user scripts API calls
- Prevents a single user from consuming shared Gemini free tier quota
- Establishes the pattern for paid tiers later

---

## Usage API

See [API Contracts](./api-contracts.md) for full endpoint details.

Two endpoints:
- `GET /api/v1/usage` — Detailed records with pagination and filtering
- `GET /api/v1/usage/summary` — Monthly aggregated breakdown

---

## Phase 2 Extension: Stripe Billing

When ready to charge users, the path is:

```
usage_records table  →  Billing Service  →  Stripe API
                              ↓
                        Subscription Plans
                        (free/starter/pro)
                              ↓
                        Usage-based metering
                        (Stripe Billing Meter)
                              ↓
                        Invoice generation
                        (monthly)
```

### What changes

| Component | Change |
|-----------|--------|
| DB | Add `billing_plans`, `subscriptions`, `invoices` tables |
| Node Gateway | Add billing routes (`/api/v1/billing/plan`, `/api/v1/billing/invoices`) |
| Node Gateway | Add Stripe webhook handler |
| Usage records | No change — already structured for billing aggregation |
| Budget limits | Tied to plan tier instead of hardcoded |

### What doesn't change

- Usage tracking code
- Usage records schema
- Pipeline stages
- AI Engine service

This is why tracking usage from day 1 matters.
