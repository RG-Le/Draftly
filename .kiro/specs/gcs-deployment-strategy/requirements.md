# Requirements Document

## Introduction

This document defines the requirements for deploying the Draftly application to Google Cloud Platform (GCP). The deployment strategy covers three areas: a local container setup script that validates the environment and prepares containers, a local development running script where application services run natively while infrastructure runs in Docker, and a complete CI/CD pipeline for GCP production deployment using Cloud Run, Cloud SQL, Memorystore, and supporting services.

## Glossary

- **Gateway**: The Node.js Express service (port 3000) handling REST APIs, WebSocket, OAuth, and Gmail I/O
- **AI_Engine**: The Python FastAPI/Celery service (port 8000) handling triage, draft generation, and profile analysis
- **Frontend**: The React/Vite static application (port 3001) serving the user interface
- **Container_Setup_Script**: A bash script (`scripts/container-setup.sh`) that validates prerequisites, injects environment variables, builds containers, and outputs logs and required commands
- **Local_Run_Script**: A bash script (`scripts/local-run.sh`) that starts infrastructure in Docker and application services natively
- **CI_CD_Pipeline**: The Cloud Build configuration that automates testing, building, and deploying to GCP
- **Cloud_Run**: GCP serverless container platform used to host Gateway, AI_Engine, and Frontend
- **Cloud_SQL**: GCP managed PostgreSQL 16 instance replacing local Postgres
- **Memorystore**: GCP managed Redis 7 instance replacing local Redis
- **Artifact_Registry**: GCP container image registry for storing built Docker images
- **Secret_Manager**: GCP service for securely storing and accessing secrets (API keys, OAuth credentials)
- **VPC_Connector**: Serverless VPC Access connector enabling Cloud Run to reach Cloud SQL and Memorystore over private networking
- **Cloud_CDN**: GCP content delivery network for serving Frontend static assets from Cloud Storage

## Requirements

### Requirement 1: Container Setup Script — Prerequisite Validation

**User Story:** As a developer, I want the container setup script to validate all prerequisites before building, so that I receive clear error messages if my environment is misconfigured.

#### Acceptance Criteria

1. WHEN the Container_Setup_Script is executed, THE Container_Setup_Script SHALL verify that Docker, Docker Compose, Node.js (v20+), Python (v3.12+), and Poetry are installed and accessible on PATH
2. IF any prerequisite tool is missing or below the minimum version, THEN THE Container_Setup_Script SHALL print a descriptive error message identifying the missing tool and required version, and exit with a non-zero status code
3. WHEN all prerequisite checks pass, THE Container_Setup_Script SHALL print a summary of detected tool versions to stdout

### Requirement 2: Container Setup Script — Environment Variable Injection

**User Story:** As a developer, I want the container setup script to validate and inject environment variables into containers, so that I do not deploy with missing configuration.

#### Acceptance Criteria

1. WHEN the Container_Setup_Script is executed, THE Container_Setup_Script SHALL read environment variables from the root `.env` file
2. THE Container_Setup_Script SHALL validate that the following required variables are set and non-empty: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SECRET_ENCRYPTION_KEY, GEMINI_API_KEY, DB_PASSWORD
3. IF any required environment variable is missing or empty, THEN THE Container_Setup_Script SHALL print an error listing all missing variables and exit with a non-zero status code
4. WHEN the SECRET_ENCRYPTION_KEY value is not exactly 64 hexadecimal characters, THE Container_Setup_Script SHALL print a validation error and exit with a non-zero status code
5. WHEN all environment variables are valid, THE Container_Setup_Script SHALL export them for use by Docker Compose build and run commands

### Requirement 3: Container Setup Script — Container Build and Output

**User Story:** As a developer, I want the container setup script to build all service containers and provide clear logs, so that I can diagnose build failures and know what commands to run next.

#### Acceptance Criteria

1. WHEN environment validation passes, THE Container_Setup_Script SHALL build Docker images for Gateway, AI_Engine, and Frontend using their respective multi-stage Dockerfiles
2. WHEN a container build fails, THE Container_Setup_Script SHALL output the build error log and exit with a non-zero status code
3. WHEN all container builds succeed, THE Container_Setup_Script SHALL output a timestamped build log to `scripts/logs/container-setup-<timestamp>.log`
4. WHEN all container builds succeed, THE Container_Setup_Script SHALL print the commands required to start the full containerized stack (docker compose up)

### Requirement 4: Local Run Script — Infrastructure in Docker

**User Story:** As a developer, I want the local run script to start only infrastructure services in Docker, so that I can run application code natively for faster iteration.

#### Acceptance Criteria

1. WHEN the Local_Run_Script is executed, THE Local_Run_Script SHALL start PostgreSQL, PgBouncer, and Redis containers using Docker Compose
2. THE Local_Run_Script SHALL wait for PostgreSQL and Redis health checks to pass before proceeding
3. IF any infrastructure container fails to become healthy within 30 seconds, THEN THE Local_Run_Script SHALL print a diagnostic message and exit with a non-zero status code

### Requirement 5: Local Run Script — Application Services Natively

**User Story:** As a developer, I want the local run script to start Gateway and AI_Engine services natively on my machine, so that I get fast hot-reload during development.

#### Acceptance Criteria

1. WHEN infrastructure containers are healthy, THE Local_Run_Script SHALL run database migrations using the Gateway Knex migration command
2. WHEN migrations complete, THE Local_Run_Script SHALL start the Gateway in development mode (port 3000) as a background process
3. WHEN migrations complete, THE Local_Run_Script SHALL start the AI_Engine FastAPI server (port 8000) as a background process
4. WHEN migrations complete, THE Local_Run_Script SHALL start the AI_Engine Celery worker (queues: triage-queue, draft-queue, profile-queue) as a background process
5. THE Local_Run_Script SHALL print the PID of each started process and write them to `scripts/.pids` for later cleanup
6. THE Local_Run_Script SHALL provide a companion stop command or trap that terminates all background processes on script exit or SIGINT

### Requirement 6: CI/CD Pipeline — Source Control Trigger

**User Story:** As a developer, I want the CI/CD pipeline to trigger automatically on pushes to the main branch, so that deployments happen without manual intervention.

#### Acceptance Criteria

1. WHEN a commit is pushed to the `main` branch, THE CI_CD_Pipeline SHALL trigger a new build
2. THE CI_CD_Pipeline SHALL be defined as a Cloud Build configuration file (`cloudbuild.yaml`) in the repository root

### Requirement 7: CI/CD Pipeline — Test Stage

**User Story:** As a developer, I want the CI/CD pipeline to run tests before deploying, so that broken code does not reach production.

#### Acceptance Criteria

1. WHEN the CI_CD_Pipeline is triggered, THE CI_CD_Pipeline SHALL run Gateway unit tests (npm test) as the first stage
2. WHEN the CI_CD_Pipeline is triggered, THE CI_CD_Pipeline SHALL run AI_Engine unit tests (pytest) as the first stage
3. IF any test fails, THEN THE CI_CD_Pipeline SHALL halt the pipeline and report the failure

### Requirement 8: CI/CD Pipeline — Container Build and Push

**User Story:** As a developer, I want the CI/CD pipeline to build and push container images to Artifact Registry, so that Cloud Run can deploy them.

#### Acceptance Criteria

1. WHEN tests pass, THE CI_CD_Pipeline SHALL build production Docker images for Gateway, AI_Engine, and Frontend
2. THE CI_CD_Pipeline SHALL tag images with the Git commit SHA and `latest`
3. THE CI_CD_Pipeline SHALL push built images to the configured Artifact_Registry repository

### Requirement 9: CI/CD Pipeline — Cloud Run Deployment

**User Story:** As a developer, I want the CI/CD pipeline to deploy services to Cloud Run automatically, so that production is updated after successful builds.

#### Acceptance Criteria

1. WHEN images are pushed to Artifact_Registry, THE CI_CD_Pipeline SHALL deploy the Gateway image to a Cloud_Run service named `draftly-gateway`
2. WHEN images are pushed to Artifact_Registry, THE CI_CD_Pipeline SHALL deploy the AI_Engine image to a Cloud_Run service named `draftly-ai-engine`
3. WHEN images are pushed to Artifact_Registry, THE CI_CD_Pipeline SHALL deploy the Frontend image to a Cloud_Run service named `draftly-frontend`
4. THE CI_CD_Pipeline SHALL configure each Cloud_Run service to use the VPC_Connector for private access to Cloud_SQL and Memorystore
5. THE CI_CD_Pipeline SHALL inject secrets from Secret_Manager as environment variables into each Cloud_Run service

### Requirement 10: GCP Infrastructure — Cloud SQL Configuration

**User Story:** As a developer, I want a managed PostgreSQL instance on Cloud SQL, so that I do not manage database backups, patching, or high availability manually.

#### Acceptance Criteria

1. THE Cloud_SQL instance SHALL run PostgreSQL 16
2. THE Cloud_SQL instance SHALL be configured with a db-f1-micro tier for initial deployment (upgradeable)
3. THE Cloud_SQL instance SHALL enable automated daily backups with 7-day retention
4. THE Cloud_SQL instance SHALL be accessible only via private IP through the VPC_Connector

### Requirement 11: GCP Infrastructure — Memorystore Configuration

**User Story:** As a developer, I want a managed Redis instance on Memorystore, so that I do not manage Redis persistence or failover manually.

#### Acceptance Criteria

1. THE Memorystore instance SHALL run Redis 7
2. THE Memorystore instance SHALL be configured with 1 GB memory capacity (Basic tier)
3. THE Memorystore instance SHALL be accessible only from services connected via the VPC_Connector

### Requirement 12: GCP Infrastructure — Secret Management

**User Story:** As a developer, I want secrets stored in Secret Manager rather than in environment files, so that credentials are not exposed in source control or container images.

#### Acceptance Criteria

1. THE Secret_Manager SHALL store the following secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SECRET_ENCRYPTION_KEY, GEMINI_API_KEY, DB_PASSWORD
2. WHEN a Cloud_Run service starts, THE Cloud_Run service SHALL retrieve secrets from Secret_Manager and expose them as environment variables
3. THE CI_CD_Pipeline SHALL NOT include secret values in build logs or container image layers

### Requirement 13: GCP Infrastructure — Networking and Security

**User Story:** As a developer, I want services to communicate over a private VPC, so that database and cache traffic is not exposed to the public internet.

#### Acceptance Criteria

1. THE VPC_Connector SHALL provide private network access between Cloud_Run services and Cloud_SQL
2. THE VPC_Connector SHALL provide private network access between Cloud_Run services and Memorystore
3. THE Gateway Cloud_Run service SHALL be the only service accepting ingress from the public internet
4. THE AI_Engine Cloud_Run service SHALL accept ingress only from within the VPC (internal traffic only)

### Requirement 14: GCP Infrastructure — Frontend Static Hosting

**User Story:** As a developer, I want the frontend served from Cloud Storage with Cloud CDN, so that static assets load quickly for users globally.

#### Acceptance Criteria

1. THE CI_CD_Pipeline SHALL build the Frontend static assets (vite build) and upload them to a Cloud Storage bucket
2. THE Cloud_CDN SHALL serve the Cloud Storage bucket contents with caching enabled
3. THE Cloud_CDN SHALL be configured with a custom domain (when provided) and managed SSL certificate

### Requirement 15: Cloud Run — Service Scaling Configuration

**User Story:** As a developer, I want Cloud Run services configured for the target scale of 1000 users with 300 peak concurrent, so that the application handles load without over-provisioning.

#### Acceptance Criteria

1. THE Gateway Cloud_Run service SHALL be configured with minimum 1 instance and maximum 5 instances
2. THE AI_Engine Cloud_Run service SHALL be configured with minimum 1 instance and maximum 3 instances
3. THE Gateway Cloud_Run service SHALL be allocated 1 vCPU and 512 MB memory per instance
4. THE AI_Engine Cloud_Run service SHALL be allocated 2 vCPU and 1 GB memory per instance (for LLM processing)
5. THE Cloud_Run services SHALL scale based on concurrent request count with a target of 80 concurrent requests per instance

### Requirement 16: Cloud Run — AI Engine Worker Deployment

**User Story:** As a developer, I want the Celery worker deployed as a separate Cloud Run service, so that background AI processing does not block the FastAPI health endpoint.

#### Acceptance Criteria

1. THE CI_CD_Pipeline SHALL deploy a separate Cloud_Run service named `draftly-ai-worker` using the AI_Engine image with the Celery worker command as entrypoint
2. THE `draftly-ai-worker` service SHALL consume from queues: triage-queue, draft-queue, profile-queue
3. THE `draftly-ai-worker` service SHALL be configured with minimum 1 instance to avoid cold-start delays on queue processing
4. THE `draftly-ai-worker` service SHALL accept no external HTTP ingress (internal only, triggered by Redis queue)

### Requirement 17: GCP Infrastructure Setup Script

**User Story:** As a beginner to cloud deployment, I want a documented setup script that provisions all GCP resources, so that I can set up the infrastructure without deep GCP expertise.

#### Acceptance Criteria

1. THE Container_Setup_Script directory SHALL include a `scripts/gcp-setup.sh` script that provisions Cloud_SQL, Memorystore, Artifact_Registry, VPC_Connector, and Cloud Storage bucket using gcloud CLI commands
2. WHEN the `gcp-setup.sh` script is executed, THE script SHALL check that the gcloud CLI is installed and authenticated
3. WHEN the `gcp-setup.sh` script is executed, THE script SHALL prompt for the GCP project ID and region before provisioning
4. THE `gcp-setup.sh` script SHALL output the connection strings and resource names needed for the Cloud Build configuration
5. IF any GCP resource already exists, THEN THE `gcp-setup.sh` script SHALL skip creation of that resource and print a notice
