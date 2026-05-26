# Implementation Plan: GCP Deployment Strategy

## Overview

Implement deployment infrastructure for Draftly on GCP. The implementation order ensures each deliverable builds on the previous: Frontend Dockerfile first (needed by container-setup), then container-setup.sh, local-run.sh, gcp-setup.sh, cloudbuild.yaml, and finally property-based tests for validation logic.

## Tasks

- [ ] 1. Create Frontend Dockerfile and nginx configuration
  - [ ] 1.1 Create `frontend/Dockerfile` with multi-stage build (node:20-alpine build stage, nginx:alpine production stage)
    - Build stage: `npm ci`, accept `VITE_API_URL` as build arg, run `npm run build`
    - Production stage: copy dist to `/usr/share/nginx/html`, copy nginx.conf, expose port 3001
    - _Requirements: 3.1, 8.1, 14.1_

  - [ ] 1.2 Create `frontend/nginx.conf` for serving the SPA
    - Listen on port 3001
    - Serve static files from `/usr/share/nginx/html`
    - Configure `try_files $uri $uri/ /index.html` for SPA routing
    - Add gzip compression for JS, CSS, HTML, JSON
    - Set cache headers for static assets
    - _Requirements: 14.1, 14.2_

- [ ] 2. Create container setup script
  - [ ] 2.1 Create `scripts/container-setup.sh` with prerequisite validation
    - Check Docker, Docker Compose v2+, Node.js v20+, Python v3.12+, Poetry are installed
    - Parse version strings and compare against minimums
    - Print descriptive error for each missing/outdated tool and exit 1
    - Print version summary when all pass
    - Support `--skip-validation` flag to bypass checks
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ] 2.2 Add environment variable validation to `scripts/container-setup.sh`
    - Read and parse root `.env` file
    - Validate GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SECRET_ENCRYPTION_KEY, GEMINI_API_KEY, DB_PASSWORD are set and non-empty
    - Validate SECRET_ENCRYPTION_KEY is exactly 64 hex characters
    - Print all missing/invalid vars in one error message, exit 1
    - Export validated vars for Docker Compose
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ] 2.3 Add container build and logging to `scripts/container-setup.sh`
    - Build Gateway, AI Engine, and Frontend images using `docker compose build`
    - Support `--service` flag to build a single service
    - On build failure: output error log and exit 2
    - On success: write timestamped log to `scripts/logs/container-setup-<timestamp>.log`
    - Print next-step commands (docker compose up)
    - Create `scripts/logs/` directory if it doesn't exist
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [ ] 3. Checkpoint - Validate container-setup.sh
  - Ensure the script runs without syntax errors, ask the user if questions arise.

- [ ] 4. Create local run script
  - [ ] 4.1 Create `scripts/local-run.sh` with infrastructure startup and health checks
    - Start postgres, pgbouncer, redis via `docker compose up -d`
    - Implement health check polling loop (max 30 seconds)
    - On timeout: print diagnostic message identifying which service failed, exit 1
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ] 4.2 Add native application service startup to `scripts/local-run.sh`
    - Run `cd gateway && npm run migrate` for database migrations
    - Start Gateway dev mode (`cd gateway && npm run dev`) as background process on port 3000
    - Start AI Engine FastAPI (`cd ai-engine && uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload`) as background process
    - Start Celery worker (`cd ai-engine && celery -A src.celery_app worker --loglevel=info --concurrency=4 --queues=triage-queue,draft-queue,profile-queue`) as background process
    - Write PIDs to `scripts/.pids` in format `service_name=PID`
    - Print PID summary table
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ] 4.3 Add stop command and signal handling to `scripts/local-run.sh`
    - Support `./scripts/local-run.sh stop` to kill tracked PIDs from `scripts/.pids`
    - Trap SIGINT/SIGTERM to kill all background processes and remove `.pids` file
    - Graceful shutdown: send SIGTERM first, SIGKILL after 5s timeout
    - _Requirements: 5.6_

- [ ] 5. Checkpoint - Validate local-run.sh
  - Ensure the script runs without syntax errors, ask the user if questions arise.

- [ ] 6. Create GCP infrastructure setup script
  - [ ] 6.1 Create `scripts/gcp-setup.sh` with gcloud validation and project configuration
    - Check gcloud CLI is installed and authenticated (`gcloud auth list`)
    - Prompt for GCP project ID and region (default: us-central1)
    - Set project with `gcloud config set project`
    - Enable required APIs: compute, run, sql, redis, secretmanager, artifactregistry, cloudbuild, vpcaccess
    - _Requirements: 17.2, 17.3_

  - [ ] 6.2 Add VPC and networking provisioning to `scripts/gcp-setup.sh`
    - Create VPC network (`draftly-vpc`)
    - Create subnet for Serverless VPC Access (`/28` range)
    - Create VPC Connector (`draftly-connector`, e2-micro, min 2 / max 3 instances)
    - Skip creation if resource already exists, print notice
    - _Requirements: 13.1, 13.2, 17.5_

  - [ ] 6.3 Add Cloud SQL and Memorystore provisioning to `scripts/gcp-setup.sh`
    - Create Cloud SQL instance (PostgreSQL 16, db-f1-micro, private IP, daily backups with 7-day retention)
    - Create database (`draftly`) and user
    - Create Memorystore instance (Redis 7, 1 GB, Basic tier, private network)
    - Skip creation if resource already exists
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 17.5_

  - [ ] 6.4 Add Artifact Registry, Secret Manager, and Cloud Build trigger to `scripts/gcp-setup.sh`
    - Create Artifact Registry repository (`draftly`, Docker format)
    - Create secrets in Secret Manager: draftly-google-client-id, draftly-google-client-secret, draftly-encryption-key, draftly-gemini-api-key, draftly-db-password
    - Create Cloud Build trigger on push to `main` branch
    - Skip creation if resource already exists
    - Output connection strings and resource names at the end
    - _Requirements: 12.1, 17.1, 17.4, 17.5_

- [ ] 7. Checkpoint - Validate gcp-setup.sh
  - Ensure the script runs without syntax errors, ask the user if questions arise.

- [ ] 8. Create Cloud Build CI/CD pipeline
  - [ ] 8.1 Create `cloudbuild.yaml` with test stage
    - Run Gateway tests: `npm ci && npm test` in gateway directory
    - Run AI Engine tests: `pip install poetry && poetry install && pytest` in ai-engine directory
    - Fail pipeline if any test fails
    - _Requirements: 6.2, 7.1, 7.2, 7.3_

  - [ ] 8.2 Add build and push stages to `cloudbuild.yaml`
    - Build production images for gateway, ai-engine, and frontend
    - Tag with `$COMMIT_SHA` and `latest`
    - Push to `$_REGION-docker.pkg.dev/$PROJECT_ID/$_ARTIFACT_REPO/SERVICE_NAME`
    - _Requirements: 8.1, 8.2, 8.3_

  - [ ] 8.3 Add deploy stage to `cloudbuild.yaml`
    - Deploy `draftly-gateway`: 1 vCPU, 512MB, min 1 / max 5, ingress all, port 3000
    - Deploy `draftly-ai-engine`: 2 vCPU, 1GB, min 1 / max 3, ingress internal, port 8000
    - Deploy `draftly-ai-worker`: 2 vCPU, 1GB, min 1 / max 3, ingress internal, Celery entrypoint, no HTTP
    - Deploy `draftly-frontend`: 1 vCPU, 256MB, min 0 / max 3, ingress all, port 3001
    - Configure `--vpc-connector` and `--set-secrets` for each service
    - Add substitution variables for region, artifact repo, VPC connector, Cloud SQL instance, Memorystore host
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 15.1, 15.2, 15.3, 15.4, 15.5, 16.1, 16.2, 16.3, 16.4_

- [ ] 9. Checkpoint - Validate cloudbuild.yaml
  - Ensure the YAML is valid and all stages reference correct images, ask the user if questions arise.

- [ ] 10. Update docker-compose.yml for full containerized mode
  - [ ] 10.1 Uncomment and update service definitions in `docker-compose.yml`
    - Add frontend service definition using the new Dockerfile
    - Ensure gateway, ai-engine-api, ai-engine-worker, celery-beat services are properly defined (currently commented out)
    - Add build context and target for each service
    - Ensure `container-setup.sh` can invoke `docker compose build` successfully
    - _Requirements: 3.1_

- [ ] 11. Create property-based tests for validation logic
  - [ ] 11.1 Set up test infrastructure
    - Create `tests/deployment/` directory
    - Install fast-check as dev dependency in a test package
    - Create `tests/deployment/validation-helpers.ts` extracting testable validation functions from container-setup.sh logic (version parsing, env var validation, hex key validation, .env parsing, PID file format)
    - _Requirements: Design testing strategy_

  - [ ]* 11.2 Write property test for prerequisite version parsing (Property 1 & 2)
    - **Property 1: Prerequisite detection correctness**
    - **Property 2: Version summary completeness**
    - Test that version comparison logic correctly identifies versions below minimum
    - Test that all 5 tool names appear in version summary output
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [ ]* 11.3 Write property test for environment variable validation (Property 3)
    - **Property 3: Environment variable validation completeness**
    - For any subset of missing required vars, error output lists ALL missing var names
    - **Validates: Requirements 2.2, 2.3**

  - [ ]* 11.4 Write property test for SECRET_ENCRYPTION_KEY validation (Property 4)
    - **Property 4: SECRET_ENCRYPTION_KEY format validation**
    - Rejects any string not exactly 64 hex chars; accepts valid 64-hex strings
    - **Validates: Requirements 2.4**

  - [ ]* 11.5 Write property test for .env file parsing (Property 5)
    - **Property 5: .env file parsing round-trip**
    - For any valid key=value pairs, parsing extracts correct values
    - **Validates: Requirements 2.1**

  - [ ]* 11.6 Write property test for PID file format (Property 6)
    - **Property 6: PID file completeness**
    - For any set of started services, .pids file contains entry for each with valid numeric PID
    - **Validates: Requirements 5.5**

  - [ ]* 11.7 Write property test for ingress isolation (Property 8)
    - **Property 8: Ingress isolation**
    - Non-gateway/frontend services always get internal-only ingress
    - **Validates: Requirements 13.3, 16.4**

- [ ] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Shell scripts use bash with `set -euo pipefail` for strict error handling
- The implementation order ensures dependencies are satisfied: Frontend Dockerfile → container-setup → local-run → gcp-setup → cloudbuild
