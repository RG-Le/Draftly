# Deployment — Design & Strategy

## Priority Order

1. **Local Docker Compose** — Build and test everything here first
2. **Local Minikube** (optional) — Validate k8s manifests if targeting Kubernetes
3. **Production** — Platform TBD (Railway, Heroku, AWS, Azure, GCP)

Production platform is not decided yet. This doc covers local deployment in detail and outlines production options for future decision.

---

## Local Deployment (Docker Compose)

### Services

| Service | Image | Port | Role |
|---------|-------|------|------|
| `gateway` | Custom (Node.js) | 3000 | REST API + WebSocket + BullMQ workers |
| `ai-engine-worker` | Custom (Python) | — | Celery workers (triage, draft, profile) |
| `ai-engine-api` | Custom (Python) | 8000 | FastAPI health/admin endpoints |
| `celery-beat` | Custom (Python) | — | Celery scheduler (periodic tasks) |
| `postgres` | postgres:16-alpine | 5432 | Primary database |
| `pgbouncer` | edoburu/pgbouncer | 6432 | Connection pooler |
| `redis` | redis:7-alpine | 6379 | Queues + cache + pub/sub |

### Docker Compose

```yaml
services:
  gateway:
    build:
      context: ./gateway
      dockerfile: Dockerfile
    command: npm run dev
    ports: ["3000:3000"]
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    volumes:
      - ./gateway/src:/app/src
    restart: unless-stopped

  ai-engine-worker:
    build:
      context: ./ai-engine
      dockerfile: Dockerfile
    command: >
      celery -A src.celery_app worker
      --loglevel=info
      --concurrency=4
      --queues=triage-queue,draft-queue,profile-queue
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    volumes:
      - ./ai-engine/src:/app/src
    restart: unless-stopped

  ai-engine-api:
    build:
      context: ./ai-engine
      dockerfile: Dockerfile
    command: uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
    ports: ["8000:8000"]
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    restart: unless-stopped

  celery-beat:
    build:
      context: ./ai-engine
      dockerfile: Dockerfile
    command: celery -A src.celery_app beat --loglevel=info
    env_file: .env
    depends_on: [redis]
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: draftly
      POSTGRES_USER: draftly
      POSTGRES_PASSWORD: ${DB_PASSWORD:-draftly_dev}
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: pg_isready -U draftly
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  pgbouncer:
    image: edoburu/pgbouncer
    environment:
      DATABASE_URL: postgres://draftly:${DB_PASSWORD:-draftly_dev}@postgres:5432/draftly
      MAX_CLIENT_CONN: 200
      DEFAULT_POOL_SIZE: 40
      POOL_MODE: transaction
    ports: ["6432:6432"]
    depends_on:
      postgres: { condition: service_healthy }
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    command: redis-server --maxmemory 512mb --maxmemory-policy allkeys-lru --appendonly yes
    volumes:
      - redisdata:/data
    healthcheck:
      test: redis-cli ping
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
```

### Dockerfiles

**Gateway (Node.js):**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

**AI Engine (Python):**

```dockerfile
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir poetry
COPY pyproject.toml poetry.lock ./
RUN poetry config virtualenvs.create false && poetry install --no-interaction
COPY . .
EXPOSE 8000
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Local Startup Steps

```bash
# 1. Clone and setup
git clone <repo>
cd draftly
cp .env.example .env
# Edit .env with your Google OAuth credentials, Gemini API key, etc.

# 2. Start all services
docker compose up -d

# 3. Run migrations
docker compose exec gateway npx knex migrate:latest

# 4. Verify
curl http://localhost:3000/api/v1/admin/health
curl http://localhost:8000/health

# 5. View logs
docker compose logs -f gateway
docker compose logs -f ai-engine-worker
```

### Local Environment Variables (.env.example)

```bash
# ===== Database =====
DB_HOST=pgbouncer
DB_PORT=6432
DB_NAME=draftly
DB_USER=draftly
DB_PASSWORD=draftly_dev

# ===== Redis =====
REDIS_URL=redis://redis:6379

# ===== Auth =====
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/api/v1/auth/google/callback
GMAIL_CALLBACK_URL=http://localhost:3000/api/v1/connections/callback

JWT_PRIVATE_KEY_PATH=./keys/private.pem
JWT_PUBLIC_KEY_PATH=./keys/public.pem
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# ===== Encryption =====
SECRET_ENCRYPTION_KEY=your-32-byte-hex-string

# ===== LLM =====
GEMINI_API_KEY=your-gemini-api-key
OPENROUTER_API_KEY=                   # Optional, leave empty to use Gemini
LLM_PRIMARY_MODEL=gemini/gemini-2.0-flash
LLM_FALLBACK_MODEL=gemini/gemini-1.5-flash

# ===== App =====
NODE_ENV=development
API_PORT=3000
CORS_ORIGINS=http://localhost:3001
ADMIN_API_KEY=your-admin-key

# ===== Rate Limits =====
RATE_LIMIT_IP_PER_MIN=200
RATE_LIMIT_USER_PER_MIN=100
LLM_BUDGET_HOURLY_TOKENS=50000
LLM_BUDGET_DAILY_TOKENS=200000
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
