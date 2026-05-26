# Cost Estimation and Scaling Strategy

## Daily Cost Breakdown (Cloud Run, us-central1)

### Cloud Run Pricing (Instance-based billing)

Source: [Cloud Run Pricing](https://cloud.google.com/run/pricing)

- CPU: $0.000018 per vCPU-second
- Memory: $0.000002 per GiB-second
- 1 day = 86,400 seconds

### Per-Service Daily Cost

| Service | vCPU | Memory | Instances | CPU/day | Memory/day | Total/day |
|---------|------|--------|-----------|---------|------------|-----------|
| draftly-gateway | 1 | 512 MB (0.5 GiB) | 1 (always on) | $1.56 | $0.09 | **$1.65** |
| draftly-ai-worker | 2 | 1 GiB | 1 (always on) | $3.11 | $0.17 | **$3.28** |
| draftly-frontend | 1 | 256 MB (0.25 GiB) | ~0.5 avg | $0.78 | $0.02 | **$0.80** |

**Cloud Run subtotal: ~$5.73/day**

### Managed Services Daily Cost

| Service | Spec | Hourly Rate | Daily Cost |
|---------|------|-------------|------------|
| Cloud SQL (db-f1-micro) | Shared vCPU, 0.6 GB RAM, 10 GB SSD | ~$0.0455/hr | **$1.09** |
| Memorystore (Redis 7, Basic, 1 GB) | 1 GB capacity | ~$0.049/hr | **$1.18** |
| VPC Connector (2x e2-micro) | 2 always-on instances | ~$0.014/hr | **$0.34** |

**Managed services subtotal: ~$2.61/day**

### Negligible Costs

| Service | Daily Cost |
|---------|------------|
| Artifact Registry (image storage, ~1 GB) | ~$0.003 |
| Secret Manager (6 secrets, ~100 accesses/day) | ~$0.001 |
| Network egress (minimal for demo) | ~$0.01 |

### Total Estimated Daily Cost

| Category | Daily | Monthly (30 days) |
|----------|-------|-------------------|
| Cloud Run | $5.73 | $171.90 |
| Managed Services | $2.61 | $78.30 |
| Other | $0.02 | $0.60 |
| **Total** | **~$8.36** | **~$250.80** |

### Free Tier Offsets

GCP provides free tier allowances per month:
- Cloud Run: 240,000 vCPU-seconds + 450,000 GiB-seconds free
- That's ~2.8 days of the gateway running free
- Saves roughly $5-10/month

**With $300 free credits: ~36 days of full operation at no cost.**

---

## Cost Optimization Tips

### For Short-Term Demo (1-7 days)

1. **Frontend min instances = 0** — scales to zero when no one is browsing (saves ~$0.80/day)
2. **Delete resources immediately after demo** — Cloud SQL and Memorystore bill even when idle
3. **Use request-based billing** for frontend — only pay when requests come in

### For Longer Operation (1 month)

1. **Consider Committed Use Discounts (CUDs)** — 17% savings on Cloud Run
2. **Schedule the AI worker** — if you don't need 24/7 processing, scale to 0 at night
3. **Use db-f1-micro** — sufficient for 100-1000 users, upgrade only if needed

### What Costs the Most

```
Memorystore (Redis)  ████████████████  $1.18/day (14%)  — no free tier, always on
Cloud SQL            ████████████████  $1.09/day (13%)  — always on
AI Worker (Cloud Run) ██████████████████████████████████  $3.28/day (39%)  — 2 vCPU always on
Gateway (Cloud Run)  ████████████████████  $1.65/day (20%)  — 1 vCPU always on
```

The AI Worker is the biggest cost because it needs 2 vCPU and must stay always-on to poll Redis queues.

---

## Scaling Strategy

### Current Target: 100-1000 Users

| Metric | Value |
|--------|-------|
| Active users | 100-1000 |
| Peak concurrent | ~300 |
| Requests/sec (peak) | ~50-100 |
| AI tasks/min (peak) | ~20-50 |

This is well within Cloud Run's capabilities with the current configuration.

### Cloud Run vs GKE Decision Matrix

| Scale | Platform | Monthly Cost | Complexity | When to Switch |
|-------|----------|-------------|------------|----------------|
| 100-1000 users | **Cloud Run** | ~$250 | Low | Current |
| 1000-5000 users | Cloud Run + optimizations | ~$400-600 | Low-Medium | Add more max instances |
| 5000-10000 users | Cloud Run or GKE Autopilot | ~$600-1200 | Medium | When you need custom scheduling |
| 10000+ users | **GKE Autopilot** | ~$800-2000+ | High | When Cloud Run limits hit |

### When Cloud Run Stops Being Enough

You'd consider GKE when:
- You need more than 8 vCPU per instance (Cloud Run limit)
- You need persistent connections beyond Cloud Run's timeout (60 min max)
- You need custom pod scheduling (GPU nodes, spot instances)
- You need service mesh (mTLS between services)
- You need more than 1000 max instances per service
- Your Celery workers need more than 3600s per task

### GKE Cost Comparison

| Component | Monthly Cost |
|-----------|-------------|
| GKE Autopilot control plane | $72 (fixed) |
| Node pool (3x e2-standard-2) | ~$150 |
| Cloud SQL (same) | ~$33 |
| Memorystore (same) | ~$35 |
| Load Balancer | ~$18 |
| **Total** | **~$308+** |

GKE is ~$60/month more expensive at this scale AND significantly more complex to manage. Not worth it until 5000+ users.

### Scaling Cloud Run (When Traffic Grows)

To handle more traffic, just increase max instances:

1. Go to Cloud Run → service → "Edit & Deploy New Revision"
2. Increase max instances:
   - Gateway: 5 → 10 → 20
   - AI Worker: 3 → 5 → 10
3. Increase CPU/memory if needed:
   - Gateway: 1 vCPU → 2 vCPU
   - AI Worker: 2 vCPU → 4 vCPU

Cloud Run auto-scales based on concurrent requests. Default target: 80 concurrent requests per instance.

### Database Scaling Path

| Users | Cloud SQL Tier | Cost/month | Notes |
|-------|---------------|-----------|-------|
| 100-500 | db-f1-micro | ~$33 | Shared vCPU, 0.6 GB RAM |
| 500-2000 | db-g1-small | ~$50 | Shared vCPU, 1.7 GB RAM |
| 2000-5000 | db-custom-1-3840 | ~$80 | 1 vCPU, 3.75 GB RAM |
| 5000-10000 | db-custom-2-7680 | ~$150 | 2 vCPU, 7.5 GB RAM + read replica |

### Redis Scaling Path

| Users | Memorystore Config | Cost/month |
|-------|-------------------|-----------|
| 100-1000 | Basic, 1 GB | ~$35 |
| 1000-5000 | Basic, 2 GB | ~$70 |
| 5000-10000 | Standard, 2 GB (with replica) | ~$140 |
