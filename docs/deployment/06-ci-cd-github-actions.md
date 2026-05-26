# CI/CD Pipeline — GitHub Actions

## Overview

The pipeline runs on every push to `main` and every pull request:

```
PR/Push → Lint & Type Check → Tests (with real Postgres + Redis) → Build Docker Images → Push to Artifact Registry → Deploy to Cloud Run
```

- PRs: Run lint + tests only (no build/deploy)
- Push to main: Full pipeline (lint → test → build → push → deploy)

## Pipeline Stages

```
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 1: Lint & Type Check (parallel per service)                    │
│  ├── Gateway: tsc --noEmit + eslint                                  │
│  ├── Frontend: tsc --noEmit                                          │
│  └── AI Engine: ruff check                                           │
├─────────────────────────────────────────────────────────────────────┤
│ Stage 2: Tests (parallel, with service containers)                   │
│  ├── Gateway: npm test (Postgres + Redis running)                    │
│  └── AI Engine: pytest (Postgres + Redis running)                    │
├─────────────────────────────────────────────────────────────────────┤
│ Stage 3: Build & Push (only on push to main)                         │
│  ├── Build gateway:SHA + gateway:latest → push to Artifact Registry  │
│  ├── Build ai-engine:SHA + ai-engine:latest → push                   │
│  └── Build frontend:SHA + frontend:latest → push                     │
├─────────────────────────────────────────────────────────────────────┤
│ Stage 4: Deploy (only on push to main)                               │
│  ├── gcloud run deploy draftly-gateway                               │
│  ├── gcloud run deploy draftly-ai-worker                             │
│  └── gcloud run deploy draftly-frontend                              │
└─────────────────────────────────────────────────────────────────────┘
```

## Setup Instructions

### Step 1: Set Up Workload Identity Federation (Recommended)

This allows GitHub Actions to authenticate with GCP without storing a service account key.

**In GCP Console:**

1. Go to **IAM & Admin → Workload Identity Federation**
2. Click "Create Pool"
   - Name: `github-actions-pool`
   - Provider: OpenID Connect (OIDC)
3. Add Provider:
   - Name: `github`
   - Issuer URL: `https://token.actions.githubusercontent.com`
   - Audience: (leave default)
4. Attribute mapping:
   - `google.subject` = `assertion.sub`
   - `attribute.repository` = `assertion.repository`
5. Attribute condition (restrict to your repo):
   ```
   assertion.repository == "YOUR_GITHUB_USERNAME/YOUR_REPO_NAME"
   ```

**Create a Service Account:**

1. Go to **IAM & Admin → Service Accounts**
2. Create: `github-actions-deployer`
3. Grant roles:
   - Cloud Run Admin
   - Artifact Registry Writer
   - Secret Manager Secret Accessor
   - Service Account User
   - Cloud Build Editor
4. Go back to Workload Identity Pool → "Grant Access"
   - Select the service account
   - Principal: `principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions-pool/attribute.repository/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME`

**Note the Workload Identity Provider resource name:**
```
projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions-pool/providers/github
```

### Step 2: Alternative — Service Account Key (Simpler but Less Secure)

If Workload Identity Federation is too complex for now:

1. Create service account `github-actions-deployer` (same roles as above)
2. Create a JSON key: Service Account → Keys → Add Key → JSON
3. Base64 encode it: `base64 -w0 key.json`
4. Store as GitHub secret `GCP_SA_KEY`

Then replace the auth step in the workflow with:
```yaml
- name: Authenticate to Google Cloud
  uses: google-github-actions/auth@v2
  with:
    credentials_json: ${{ secrets.GCP_SA_KEY }}
```

### Step 3: Configure GitHub Secrets

Go to your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

| Secret Name | Value | Where to Find It |
|-------------|-------|-----------------|
| `GCP_PROJECT_ID` | Your GCP project ID | GCP Console → Project dropdown |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/NUMBER/locations/global/workloadIdentityPools/github-actions-pool/providers/github` | Step 1 above |
| `GCP_SERVICE_ACCOUNT` | `github-actions-deployer@PROJECT_ID.iam.gserviceaccount.com` | IAM → Service Accounts |
| `VPC_CONNECTOR` | `draftly-connector` | Serverless VPC Access |
| `DB_HOST` | Cloud SQL private IP (e.g., `10.0.0.2`) | Cloud SQL → Overview |
| `REDIS_HOST` | Memorystore IP (e.g., `10.0.0.3`) | Memorystore → Instance |
| `GATEWAY_URL` | `https://draftly-gateway-XXXXX.run.app` | Cloud Run → Gateway service |
| `FRONTEND_URL` | `https://draftly-frontend-XXXXX.run.app` | Cloud Run → Frontend service |

### Step 4: Verify the Pipeline

1. Push a commit to `main`
2. Go to GitHub → Actions tab → watch the pipeline run
3. Check each stage passes
4. Verify Cloud Run services updated (check revision in GCP Console)

## What Happens on Each Trigger

| Trigger | Lint | Tests | Build | Deploy |
|---------|------|-------|-------|--------|
| PR to main | ✅ | ✅ | ❌ | ❌ |
| Push to main | ✅ | ✅ | ✅ | ✅ |
| Push to other branch | ❌ | ❌ | ❌ | ❌ |

## Test Environment

Tests run with real Postgres and Redis (GitHub Actions service containers):
- PostgreSQL 16 on localhost:5432 (database: `draftly_test`)
- Redis 7 on localhost:6379
- Fake credentials for Google OAuth and encryption key
- No actual LLM calls (tests should mock LLM responses)

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Auth fails in build-and-push | Workload Identity not configured | Check provider URL and service account permissions |
| Docker push fails | Artifact Registry permissions | Grant "Artifact Registry Writer" to service account |
| Deploy fails with secret error | Secret Manager access | Grant "Secret Manager Secret Accessor" to compute service account |
| Tests fail — can't connect to DB | Service container not ready | Health check should handle this; increase retries |
| Frontend build fails | Missing VITE_API_URL | Set GATEWAY_URL secret |
| "No tests found" | Tests not written yet | Expected — pipeline continues with build |

## Adding Tests Later

When you add tests, they'll automatically run in the pipeline:

**Gateway tests** (Jest):
- Create files matching `**/*.test.ts` in `gateway/`
- They'll run with `npm test`

**AI Engine tests** (pytest):
- Create files in `ai-engine/tests/`
- They'll run with `poetry run pytest tests/`

The pipeline already has Postgres + Redis service containers ready for integration tests.
