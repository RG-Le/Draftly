# Local and Docker Setup

This document explains two reliable development modes:

- **Hybrid local mode (recommended):** run app services locally, keep Postgres/PgBouncer/Redis in Docker.
- **Full Docker mode:** run everything through `docker compose`.

---

## 1) Prerequisites

- Node.js `>=20` for `gateway`
- Python `3.12` + Poetry for `ai-engine`
- Docker Desktop
- A configured `.env` at repo root (copy from `.env.example`)

Key environment behavior:

- `gateway` uses `DB_HOST` + `DB_PORT` from env and is intended to use PgBouncer (`6432`) in normal runtime.
- migration CLI in `gateway/src/infrastructure/database/knexfile.ts` intentionally bypasses PgBouncer and runs DDL against Postgres on `5432`.
- `ai-engine` defaults to direct Postgres (`5432`) and Redis, not PgBouncer.

---

## 2) One-Time Environment Setup

From repo root:

1. Copy env template:
   - Windows PowerShell: `Copy-Item .env.example .env`
2. Fill required values:
   - `DB_PASSWORD`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `SECRET_ENCRYPTION_KEY` (64 hex chars)
   - `GEMINI_API_KEY` (or `OPENROUTER_API_KEY`)

JWT setup for gateway:

- Run in `gateway` once: `npm run generate:keys`
- This creates keys expected by:
  - `JWT_PRIVATE_KEY_PATH=./keys/private.pem`
  - `JWT_PUBLIC_KEY_PATH=./keys/public.pem`

---

## 3) Hybrid Local Mode (Recommended)

### Step A: Start infra in Docker

From repo root:

```bash
docker compose up -d postgres pgbouncer redis
```

### Step B: Run DB migrations

From `gateway`:

```bash
npm ci
npm run migrate
```

### Step C: Start gateway locally

From `gateway`:

```bash
npm run dev
```

Gateway serves on `http://localhost:3000`.

### Step D: Start ai-engine worker locally

From `ai-engine`:

```bash
poetry install
poetry run celery -A src.celery_app worker --loglevel=info --concurrency=4 --queues=triage-queue,draft-queue,profile-queue
```

### Step E (optional): Start ai-engine API locally

From `ai-engine`:

```bash
poetry run uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
```

AI API serves on `http://localhost:8000`.

---

## 4) Full Docker Mode

From repo root:

```bash
docker compose up --build
```

This starts:

- `gateway` (3000)
- `ai-engine-api` (8000)
- `ai-engine-worker`
- `celery-beat`
- `postgres` (5432)
- `pgbouncer` (6432)
- `redis` (6379)

Notes:

- Source folders are mounted in compose, so code edits in `gateway/src` and `ai-engine/src` reflect immediately.
- `gateway` and `ai-engine-api` run with reload/watch commands in compose.

---

## 5) Smoke Test Checklist

1. Check infra containers:
   - `docker compose ps`
2. Check gateway health:
   - `GET http://localhost:3000/api/v1/admin/health`
3. Check ai-engine health:
   - `GET http://localhost:8000/health`
4. Trigger auth and connector flow from API collection in `docs/Draftly-Phase2.postman_collection.json`
5. Verify Redis queue activity for:
   - `gmail-sync`
   - `triage-queue`
   - `draft-queue`
   - `profile-queue`

---

## 6) Common Setup Pitfalls

- **OAuth callback mismatch:** ensure Google console redirect URIs match values in `.env`.
- **JWT key errors in gateway startup:** run `npm run generate:keys` in `gateway`.
- **Migration fails through PgBouncer:** run migrations via `gateway` scripts only (already configured for direct PG 5432).
- **AI tasks stuck in Redis queue:** check that `ai-engine` Celery worker is running with all 3 queues.
- **Connection refused from local services:** if running locally against Docker infra, use `.env` values that point to localhost ports as needed.
