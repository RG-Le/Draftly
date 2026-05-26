# Draftly - AI-Powered Email Triage & Drafting

Draftly is a comprehensive system designed to connect to your Gmail account, intelligently analyze incoming emails using LLMs, and automatically categorize them and prepare draft responses based on your communication style.

## 🏗️ Architecture & Tech Stack

Draftly is built using a microservices-inspired architecture with the following components:

- **Frontend:** React, Vite, TypeScript, React Query, Socket.io-client
- **Gateway (Backend API):** Node.js, Express, Knex.js, BullMQ, Passport.js (Google OAuth)
- **AI Engine:** Python, FastAPI, Celery, SQLAlchemy, LiteLLM (supports Gemini, OpenRouter)
- **Infrastructure:** PostgreSQL 16, PgBouncer (Connection Pooling), Redis 7 (Caching & Message Broker), Docker

---

## 📋 Prerequisites

Before setting up Draftly locally, ensure you have the following installed:

- **Node.js** (v20 or higher)
- **Python** (v3.12 or higher)
- **Docker & Docker Compose** (Docker Desktop on Windows/Mac)
- **Git**
- **Poetry** (Python dependency manager)

**Windows-specific notes:**
- Use Docker Desktop with WSL2 backend
- Celery workers use `--pool=solo` on Windows (no prefork support)
- All scripts work in PowerShell or Git Bash

You will also need credentials from external services:
1. **Google Cloud Console:** Create a project, enable the Gmail API, and create OAuth 2.0 Client credentials. Add `http://localhost:3000/api/v1/auth/google/callback` to the Authorized redirect URIs.
2. **Gemini API Key:** (Or OpenRouter key) for the LLM engine to process emails.

---

## 🚀 Local Development Setup Guide

Follow these steps exactly to run the complete Draftly ecosystem locally.

### 1. Environment Variables Configuration

Copy the example environment file in the root directory:

```bash
cp .env.example .env
```

Open `.env` and fill in the missing values:
- `GOOGLE_CLIENT_ID`: Your Google OAuth Client ID.
- `GOOGLE_CLIENT_SECRET`: Your Google OAuth Client Secret.
- `SECRET_ENCRYPTION_KEY`: Generate a secure 64-character hex string. You can generate one by running this in your terminal: 
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `GEMINI_API_KEY`: Your AI model API key.

### 2. Infrastructure Setup (Docker)

We use Docker to run PostgreSQL, Redis, and PgBouncer locally without cluttering your system. 

Open a terminal in the root project directory and run:

```bash
docker compose up -d postgres redis pgbouncer
```

*Wait a few seconds for the containers to become fully healthy before proceeding.*

### 3. Gateway (Node.js API) Setup

The Gateway handles user authentication, REST APIs, WebSockets, and Gmail integration.

Open a new terminal window:
```bash
cd gateway

# 1. Install node modules
npm install

# 2. Generate JWT RSA keypairs (Required for authentication)
npm run generate:keys

# 3. Run database migrations to set up the Postgres schema
npm run migrate

# 4. Start the development server
npm run dev
```
*The Gateway will now be running on `http://localhost:3000`.*

### 4. AI Engine (Python) Setup

The AI Engine manages heavy lifting, including semantic profile building, triage, and drafting via background jobs.

Open a new terminal window:
```bash
cd ai-engine

# 1. Create a virtual environment
python -m venv .venv

# 2. Activate the virtual environment
# On Windows:
.venv\Scripts\activate
# On Mac/Linux:
source .venv/bin/activate

# 3. Install dependencies using Poetry
pip install poetry
poetry install

# Alternatively, if you prefer pip with the generated requirements.txt:
# pip install -r requirements.txt
```

**Running the AI Engine Services:**
You need to start three separate processes for the AI engine to function completely. Run these in three separate terminal windows (ensure the `.venv` is activated in each):

**Terminal A (FastAPI Server):**
```bash
uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
```

**Terminal B (Celery Worker):**
```bash
celery -A src.celery_app worker --loglevel=info --concurrency=4 --queues=triage-queue,draft-queue,profile-queue
```

**Terminal C (Celery Beat - Scheduled Tasks):**
```bash
celery -A src.celery_app beat --loglevel=info
```

### 5. Frontend Setup

The frontend is the UI where users will interact with the system.

Open a new terminal window:
```bash
cd frontend

# 1. Install dependencies
npm install

# 2. Start the Vite development server
npm run dev
```
*The Frontend will now be available at `http://localhost:3001`.*

---

## ⚙️ How It Works (System Flow)

1. **User Authentication:** 
   You open `http://localhost:3001` and click Login. The gateway redirects you to Google for authentication and requests Gmail read/write scopes.
2. **Data Ingestion:**
   The Gateway syncs your recent Gmail messages and stores the metadata in PostgreSQL.
3. **Queueing:**
   Events like "New Email Synced" are published to Redis (acting as a message broker).
4. **AI Processing:**
   The Celery workers in the AI Engine pick up these tasks. They call the configured LLMs (like Gemini 2.0 Flash) to triage the email, assess priority, learn your communication style, and optionally draft a response.
5. **Real-time Notifications:**
   Once the AI completes a draft, it updates the database and triggers a WebSocket event via the Gateway, immediately updating the React frontend so you can review, approve, or discard the draft.
