# Draftly Documentation Index

## Core Design

| Document | Purpose |
|----------|---------|
| [Scope Freeze](./scope-freeze.md) | What's in scope, what's out, domain invariants, capstone requirements |
| [Core Solution Design (100 Users)](./core-solution-design-100-users.md) | Original 100-user modular monolith reference design |
| [System Design Overview](./system-design-overview.md) | Architecture decisions, service topology, tech stack, high-level data flow |
| [Implementation Plan](./implementation-plan.md) | Complete v2 design document — all decisions, domain model, schema, API, pipelines, phased build order |
| [Code Walkthrough](./code-walkthrough/README.md) | Practical setup, onboarding & draft pipelines, DB scripts, debugging |
| [Frontend documentation](./frontend-documentation/README.md) | React/Vite SPA architecture, modules, routing, API + realtime conventions for agents |

## Service Documentation

| Document | Purpose |
|----------|---------|
| [Gateway Service](./gateway-service.md) | Node.js Gateway — role, structure, components, middleware, error handling |
| [AI Engine Service](./ai-engine-service.md) | Python AI Engine — pipelines, LLM routing, Celery tasks, prompt management |
| [Inter-Service Communication](./inter-service-communication.md) | How Node and Python talk — CeleryBridge, Redis pub/sub, shared DB |

## Data & API

| Document | Purpose |
|----------|---------|
| [Database Design](./database-design.md) | Schema, ER diagram, indexes, connection pooling, migration strategy |
| [API Contracts](./api-contracts.md) | Complete REST API reference — all endpoints, request/response formats, WebSocket events |

## Cross-Cutting Concerns

| Document | Purpose |
|----------|---------|
| [Authentication & Security](./authentication-and-security.md) | OAuth-first flow, JWT, PKCE, encryption, rate limiting, CORS, PII handling |
| [Extensibility](./extensibility.md) | Workflow-first architecture, connector registry, adding new use cases |
| [Billing & Usage](./billing-and-usage.md) | Cost tracking, LLM budget enforcement, Stripe extension path |
| [Concurrency & Reliability](./concurrency-and-reliability.md) | Idempotency, optimistic locking, circuit breakers, failure recovery |
| [Observability](./observability.md) | Metrics, logging, correlation IDs, health checks, alert thresholds |
| [Deployment](./deployment.md) | Docker Compose (local), production options comparison, topology |

## Problem Statements

| Document | Purpose |
|----------|---------|
| [Problem Statements](../problem-statement-docs/all%20problem%20statements%20text.txt) | Original capstone case study requirements |

---

## Reading Order

**For understanding the system:** Scope Freeze → System Design Overview → Gateway Service → AI Engine Service → Inter-Service Communication

**For implementation:** System Design Overview → Database Design → API Contracts → Gateway Service → AI Engine Service

**For capstone review:** Scope Freeze → System Design Overview → API Contracts → Concurrency & Reliability → Authentication & Security
