# Draftly Code Walkthrough

This guide is a practical, code-first walkthrough of the repository so you can:

- run the system locally (hybrid and full Docker modes),
- understand how requests and async jobs move across services,
- map features to files quickly,
- debug failures with a predictable checklist.

## What This Covers

- `gateway` (Node.js + Express + BullMQ + OAuth + WebSocket)
- `ai-engine` (FastAPI health/admin + Celery workers + AI pipelines)
- shared dependencies (Postgres, PgBouncer, Redis)
- database migrations and schema evolution scripts

## Recommended Reading Order

1. [01-local-and-docker-setup.md](./01-local-and-docker-setup.md)
2. [02-codebase-map-and-flows.md](./02-codebase-map-and-flows.md)
3. [03-database-scripts-and-schema.md](./03-database-scripts-and-schema.md)
4. [04-debugging-playbook.md](./04-debugging-playbook.md)
5. [05-onboarding-flow-explained.md](./05-onboarding-flow-explained.md) — signup, Gmail connect, persona bootstrap
6. [06-email-sync-and-draft-pipeline-explained.md](./06-email-sync-and-draft-pipeline-explained.md) — sync triggers & full Celery/BullMQ draft path

## Quick Start (Fastest Working Setup)

1. Start infra only:
   - `docker compose up -d postgres pgbouncer redis`
2. Run migrations from `gateway`:
   - `npm ci`
   - `npm run migrate`
3. Start `gateway` locally:
   - `npm run generate:keys`
   - `npm run dev`
4. Start `ai-engine` worker locally:
   - `poetry install`
   - `poetry run celery -A src.celery_app worker --loglevel=info --concurrency=4 --queues=triage-queue,draft-queue,profile-queue`
5. (Optional) Start `ai-engine` API locally:
   - `poetry run uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload`

## Health Endpoints

- Gateway deep health: `GET /api/v1/admin/health`
- Gateway liveness: `GET /api/v1/admin/ping`
- AI engine deep health: `GET /health`
- AI engine liveness: `GET /ping`
