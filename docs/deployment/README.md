# Draftly — GCP Deployment Documentation

This folder contains the complete deployment documentation for Draftly on Google Cloud Platform.

## Documents

| Document | Description |
|----------|-------------|
| [GCP Architecture Overview](./01-gcp-architecture-overview.md) | System architecture, service topology, networking, and design decisions |
| [Manual GCP Console Setup](./02-manual-gcp-console-setup.md) | Step-by-step guide to provision all GCP resources from the console |
| [Build and Deploy Services](./03-build-and-deploy-services.md) | Building Docker images, pushing to Artifact Registry, deploying to Cloud Run |
| [Cost Estimation and Scaling](./04-cost-estimation-and-scaling.md) | Pricing breakdown, scaling strategy, Cloud Run vs GKE decision |
| [Queue Architecture Decisions](./05-queue-architecture-decisions.md) | Why BullMQ/Celery over RabbitMQ, SQS, or Google Cloud Tasks |

## Quick Reference

| Resource | Value |
|----------|-------|
| Region | us-central1 |
| VPC | draftly-vpc |
| VPC Connector | draftly-connector |
| Cloud SQL Instance | draftly-db (PostgreSQL 16) |
| Memorystore Instance | draftly-redis (Redis 7, 1 GB) |
| Artifact Registry | us-central1-docker.pkg.dev/PROJECT_ID/draftly/ |
| Gateway Service | draftly-gateway (port 3000) |
| AI Worker Service | draftly-ai-worker (Celery) |
| Frontend Service | draftly-frontend (port 3001) |

## Estimated Daily Cost

~$8.35/day with free tier credits covering the first ~36 days.
