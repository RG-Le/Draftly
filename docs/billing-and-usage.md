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

**Python AI Engine** — after every LLM call:

```python
async def record_llm_usage(
    user_id: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    estimated_cost: Decimal,
    correlation_id: str,
):
    await usage_repo.insert({
        "user_id": user_id,
        "resource_type": "llm_input_tokens",
        "resource_detail": model,
        "quantity": input_tokens,
        "estimated_cost_usd": estimated_cost * Decimal("0.3"),  # Rough input ratio
        "usage_date": date.today(),
        "correlation_id": correlation_id,
    })
    await usage_repo.insert({
        "user_id": user_id,
        "resource_type": "llm_output_tokens",
        "resource_detail": model,
        "quantity": output_tokens,
        "estimated_cost_usd": estimated_cost * Decimal("0.7"),  # Rough output ratio
        "usage_date": date.today(),
        "correlation_id": correlation_id,
    })
```

**Node Gateway** — after every Gmail API call:

```typescript
await usageRepo.insert({
  userId,
  resourceType: 'gmail_api_call',
  resourceDetail: 'messages.list',
  quantity: 1,
  estimatedCostUsd: 0,
  usageDate: new Date(),
  correlationId,
});
```

### Performance consideration

Usage recording is a DB write on every operation. At 4500 LLM calls/hour, that's 9000 usage records/hour (input + output tokens tracked separately).

Mitigations:
- `usage_records` is partitioned by `usage_date` — monthly partitions keep table sizes manageable.
- Inserts are append-only (no updates, no locks).
- Can batch inserts if needed (accumulate in Redis counter, flush to DB every minute).

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
