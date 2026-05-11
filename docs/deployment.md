# Deployment — Design & Strategy

## Priority Order

1. **Local Docker Compose** — Build and test everything here first
2. **Local Minikube** (optional) — Validate k8s manifests if targeting Kubernetes
3. **Production** — Platform TBD (Railway, Heroku, AWS, Azure, GCP)

Production platform is not decided yet. This doc covers local deployment in detail and outlines production options for future decision.

---

## Local Deployment (Docker Compose)

### Current Setup

The Docker Compose file runs **infrastructure services only** (Postgres, PgBouncer, Redis). The application services (Gateway, AI Engine) are run locally for faster development iteration.

### Services

| Service | Image | Port | Role |
|---------|-------|------|------|
| `postgres` | postgres:16-alpine | 5432 | Primary database |
| `pgbouncer` | edoburu/pgbouncer | 6432 | Connection pooler |
| `redis` | redis:7-alpine | 6379 | Queues + cache + pub/sub |

Application services (commented out in docker-compose.yml, run locally):
| Service | Port | How to run locally |
|---------|------|-------------------|
| Gateway | 3000 | `cd gateway && npm run dev` |
| AI Engine Worker | — | `cd ai-engine && celery -A src.celery_app worker --queues=triage-queue,draft-queue,profile-queue` |
| AI Engine API | 8000 | `cd ai-engine && uvicorn src.main:app --port 8000 --reload` |
| Frontend | 5173 | `cd frontend && npm run dev` |

### Docker Compose (actual)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: draftly
      POSTGRES_USER: draftly
      POSTGRES_PASSWORD: ${DB_PASSWORD:-draftly_dev_password}
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U draftly -d draftly"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  pgbouncer:
    image: edoburu/pgbouncer:latest
    environment:
      DATABASE_URL: postgres://draftly:${DB_PASSWORD:-draftly_dev_password}@postgres:5432/draftly
      LISTEN_PORT: 6432
      MAX_CLIENT_CONN: 200
      DEFAULT_POOL_SIZE: 40
      POOL_MODE: transaction
      AUTH_TYPE: plain
    ports: ["6432:6432"]
    depends_on:
      postgres: { condition: service_healthy }
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    command: >
      redis-server
      --maxmemory 512mb
      --maxmemory-policy allkeys-lru
      --appendonly yes
      --appendfsync everysec
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
```

> **Note:** The docker-compose.yml also contains commented-out service definitions for gateway, ai-engine-worker, ai-engine-api, and celery-beat. These can be uncommented for full containerized deployment.

### Local Startup Steps

```bash
# 1. Clone and setup
git clone <repo>
cd draftly
cp .env.example .env
# Edit .env with your Google OAuth credentials, Gemini API key, etc.

# 2. Start infrastructure
docker compose up -d

# 3. Run migrations
cd gateway && npx knex migrate:latest

# 4. Generate JWT keys (if not present)
cd gateway && mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem

# 5. Start services locally
# Terminal 1: Gateway
cd gateway && npm run dev

# Terminal 2: AI Engine worker
cd ai-engine && celery -A src.celery_app worker --loglevel=info --queues=triage-queue,draft-queue,profile-queue

# Terminal 3: Frontend
cd frontend && npm run dev

# 6. Verify
curl http://localhost:3000/api/v1/health
```

### Local Environment Variables (.env)

```bash
# ===== Application =====
NODE_ENV=development
API_PORT=3000
CORS_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:5173

# ===== Database (PgBouncer) =====
DB_HOST=localhost
DB_PORT=6432
DB_NAME=draftly
DB_USER=draftly
DB_PASSWORD=draftly_dev_password

# ===== Redis =====
REDIS_URL=redis://127.0.0.1:6379

# ===== Google OAuth (Login - Step 1) =====
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/api/v1/auth/google/callback

# ===== Gmail OAuth (Mail scopes - Step 2) =====
GMAIL_CALLBACK_URL=http://localhost:3000/api/v1/connections/callback

# ===== JWT (RS256) =====
JWT_PRIVATE_KEY_PATH=./keys/private.pem
JWT_PUBLIC_KEY_PATH=./keys/public.pem
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# ===== Encryption =====
SECRET_ENCRYPTION_KEY=your-64-char-hex-string

# ===== LLM =====
GEMINI_API_KEY=your-gemini-api-key
OPENROUTER_API_KEY=                   # Optional
LLM_PRIMARY_MODEL=gemini/gemini-2.0-flash
LLM_FALLBACK_MODEL=gemini/gemini-1.5-flash

# ===== Rate Limits =====
RATE_LIMIT_IP_PER_MIN=200
RATE_LIMIT_USER_PER_MIN=100

# ===== Triage =====
TRIAGE_BATCH_SIZE=25

# ===== Admin =====
ADMIN_API_KEY=dev-admin-key
```

---

## Local Testing Strategy

### 1. Unit Tests (no Docker needed)

```bash
# Gateway
cd gateway && npm test

# AI Engine
cd ai-engine && pytest tests/unit
```

### 2. Integration Tests (Docker services running)

```bash
# Gateway (tests against real DB + Redis)
cd gateway && npm run test:integration

# AI Engine
cd ai-engine && pytest tests/integration
```

### 3. E2E Tests (full stack running)

```bash
# Full workflow test
npm run test:e2e
```

### 4. Manual API Testing

Postman collection or curl scripts for all endpoints. Import the API contracts as reference.

### 5. Load Testing

```bash
# k6 for concurrent user simulation
k6 run tests/load/concurrent-300.js --vus 300 --duration 5m
```

---

## Production Deployment — Options Analysis

Platform decision is pending. Here's an honest comparison:

### PaaS Options (simple)

| Platform | Pros | Cons | Est. Cost |
|----------|------|------|-----------|
| **Railway** | Docker Compose-like deploys, easy env vars, auto-scaling, built-in Redis + Postgres addons | Smaller community, fewer docs | $20–50/month |
| **Render** | Free tier available, Docker support, managed Postgres + Redis, auto-deploy from Git | Cold starts on free tier, limited worker support | $25–60/month |
| **Heroku** | Very mature, good worker dyno support, managed Postgres + Redis addons | More expensive, Salesforce ownership uncertainty | $50–100/month |

### Cloud Options (full control)

| Platform | Pros | Cons | Est. Cost |
|----------|------|------|-----------|
| **AWS ECS Fargate** | Serverless containers, auto-scaling, integrated with RDS + ElastiCache | More configuration, AWS learning curve | $50–150/month |
| **AWS EKS** | Full Kubernetes, maximum flexibility, production-grade | Complex, $72/month just for control plane | $100–200/month |
| **GCP Cloud Run** | Serverless, good for containers, competitive pricing | Cold starts, less worker support | $30–80/month |
| **Azure Container Apps** | Kubernetes-based, good CI/CD, DAPR support | Less ecosystem than AWS/GCP for this use case | $50–120/month |

### Recommendation

**For capstone demo:** Railway or Render. Deploy from Git, managed add-ons, minimal ops burden.

**For product launch:** AWS ECS Fargate. Managed containers without Kubernetes complexity. Scale specific services independently.

**For team growth:** AWS EKS or GCP GKE. Full Kubernetes when you need it.

---

## Production Architecture (when decided)

Regardless of platform, the production topology will be:

```
                    ┌─────────────────┐
                    │  Load Balancer   │
                    │  (TLS + Rate)    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ Gateway  │  │ Gateway  │  │ Gateway  │
        │ Instance │  │ Instance │  │ Instance │
        └──────┬───┘  └──────┬───┘  └──────┬───┘
               │             │             │
               ▼             ▼             ▼
        ┌────────────────────────────────────┐
        │          PgBouncer                  │
        │     (connection pooler)             │
        └───────────────┬────────────────────┘
                        │
              ┌─────────┼─────────┐
              ▼                   ▼
        ┌──────────┐        ┌──────────┐
        │ Postgres │        │ Postgres │
        │ Primary  │───────►│ Replica  │
        └──────────┘        └──────────┘
              ▲
              │
        ┌─────┴──────┐
        │   Redis    │
        │  (Managed) │
        └─────┬──────┘
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
┌────────┐ ┌────────┐ ┌────────┐
│ AI     │ │ AI     │ │ Celery │
│ Worker │ │ Worker │ │  Beat  │
└────────┘ └────────┘ └────────┘
```

### Scaling rules

| Component | Horizontal scaling trigger |
|-----------|---------------------------|
| Gateway instances | CPU > 70% OR request latency p95 > 500ms |
| AI Worker instances | Queue depth > 50 (draft-queue) |
| Postgres read replica | Read query latency p95 > 100ms |
| Redis | Memory > 80% |

---

## CI/CD Pipeline (when ready)

```
Push to main → Run tests → Build Docker images → Push to registry → Deploy to staging → Run smoke tests → Promote to production
```

Tools: GitHub Actions or GitLab CI. Docker registry: GHCR, ECR, or GCR depending on platform.

Not building this now. Focus is local Docker Compose → complete backend → test endpoints → frontend → then deployment.
