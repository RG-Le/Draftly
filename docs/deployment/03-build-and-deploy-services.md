# Build and Deploy Services

This guide covers building Docker images locally, pushing them to Artifact Registry, and deploying Cloud Run services.

## Prerequisites

- All GCP infrastructure provisioned (see [Manual GCP Console Setup](./02-manual-gcp-console-setup.md))
- Docker installed locally
- `gcloud` CLI installed and authenticated
- Note your:
  - **Project ID** (e.g., `draftly-prod-12345`)
  - **Cloud SQL Private IP** (e.g., `10.0.0.2`)
  - **Memorystore IP** (e.g., `10.0.0.3`)

## Step 1: Install and Configure gcloud CLI

If not already installed:

```bash
# Download and install (Linux)
curl -O https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz
tar -xf google-cloud-cli-linux-x86_64.tar.gz
./google-cloud-sdk/install.sh

# Initialize
gcloud init

# Login
gcloud auth login

# Set project
gcloud config set project YOUR_PROJECT_ID
```

## Step 2: Configure Docker for Artifact Registry

```bash
# Authenticate Docker with your GCP Artifact Registry
gcloud auth configure-docker us-central1-docker.pkg.dev
```

## Step 3: Set Environment Variables

```bash
export PROJECT_ID=your-project-id
export REGION=us-central1
export REGISTRY=$REGION-docker.pkg.dev/$PROJECT_ID/draftly
```

## Step 4: Build Docker Images

### Gateway

```bash
docker build -t $REGISTRY/gateway:latest -t $REGISTRY/gateway:$(git rev-parse --short HEAD) ./gateway
```

### AI Engine

```bash
docker build -t $REGISTRY/ai-engine:latest -t $REGISTRY/ai-engine:$(git rev-parse --short HEAD) ./ai-engine
```

### Frontend

You need a Frontend Dockerfile first. Create `frontend/Dockerfile`:

```dockerfile
# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# Production stage
FROM nginx:alpine AS production
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3001
CMD ["nginx", "-g", "daemon off;"]
```

Create `frontend/nginx.conf`:

```nginx
server {
    listen 3001;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # SPA routing — all paths serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml text/javascript image/svg+xml;
    gzip_min_length 1000;
}
```

Build the frontend (pass the Gateway URL as build arg):

```bash
docker build \
  --build-arg VITE_API_URL=https://draftly-gateway-XXXXX.run.app \
  -t $REGISTRY/frontend:latest \
  -t $REGISTRY/frontend:$(git rev-parse --short HEAD) \
  ./frontend
```

> Note: You'll get the Gateway URL after deploying it. You may need to rebuild and redeploy the frontend once you have the URL.

## Step 5: Push Images to Artifact Registry

```bash
docker push $REGISTRY/gateway:latest
docker push $REGISTRY/ai-engine:latest
docker push $REGISTRY/frontend:latest
```

## Step 6: Deploy Cloud Run Services

### 6a: Deploy Gateway

From the GCP Console:

1. Go to **Cloud Run** → **"Create Service"**
2. **Container image:** Click "Select" → navigate to `us-central1-docker.pkg.dev/PROJECT_ID/draftly/gateway:latest`
3. **Service name:** `draftly-gateway`
4. **Region:** `us-central1`
5. **Authentication:** Allow unauthenticated invocations
6. Click **"Container(s), Volumes, Networking, Security"** to expand:

**Container tab:**
- Container port: `3000`
- CPU: `1`
- Memory: `512 MiB`
- Request timeout: `300`
- Min instances: `1`
- Max instances: `5`

**Variables & Secrets tab:**

Environment variables:
| Name | Value |
|------|-------|
| `NODE_ENV` | `production` |
| `API_PORT` | `3000` |
| `DB_HOST` | `10.0.0.2` (your Cloud SQL private IP) |
| `DB_PORT` | `5432` |
| `DB_NAME` | `draftly` |
| `DB_USER` | `draftly` |
| `REDIS_URL` | `redis://10.0.0.3:6379` (your Memorystore IP) |
| `CORS_ORIGINS` | `https://draftly-frontend-XXXXX.run.app` (update after frontend deploy) |
| `GOOGLE_CALLBACK_URL` | `https://draftly-gateway-XXXXX.run.app/api/v1/auth/google/callback` |
| `GMAIL_CALLBACK_URL` | `https://draftly-gateway-XXXXX.run.app/api/v1/connections/callback` |
| `JWT_ACCESS_EXPIRY` | `15m` |
| `JWT_REFRESH_EXPIRY` | `7d` |

Secrets (click "Reference a Secret"):
| Name | Secret | Version |
|------|--------|---------|
| `GOOGLE_CLIENT_ID` | `draftly-google-client-id` | latest |
| `GOOGLE_CLIENT_SECRET` | `draftly-google-client-secret` | latest |
| `SECRET_ENCRYPTION_KEY` | `draftly-encryption-key` | latest |
| `DB_PASSWORD` | `draftly-db-password` | latest |

**Networking tab:**
- Ingress: **All**
- VPC connector: `draftly-connector`
- VPC egress: **"Route only requests to private IPs through the VPC connector"**
  > ⚠️ Do NOT choose "Route all traffic". The Gateway needs to reach Google OAuth APIs and other
  > external services. "Private IPs only" routes DB/Redis traffic through the VPC while all other
  > outbound traffic goes directly to the internet — no Cloud NAT needed.

7. Click **"Create"**

Wait for deployment. Note the service URL (e.g., `https://draftly-gateway-abc123.run.app`).

### 6b: Deploy AI Worker

> **Architecture note:** The AI worker is queue-driven — it pulls jobs from Redis (BullMQ),
> makes outbound calls to PostgreSQL (Cloud SQL private IP), OpenRouter/Gemini LLM APIs
> (internet), and Google Gmail API (internet). It does **not** receive inbound HTTP from the
> internet. Networking must be configured accordingly:
> - **Ingress = Internal** → blocks unsolicited inbound HTTP (correct; the worker is not an HTTP server for external traffic)
> - **VPC Egress = Private IPs only** → routes only `10.x.x.x` DB/Redis traffic through the VPC connector; all other outbound traffic (OpenRouter, Gmail, etc.) exits directly to the internet without needing Cloud NAT

1. Go to **Cloud Run** → **"Create Service"**
2. **Container image:** `us-central1-docker.pkg.dev/PROJECT_ID/draftly/ai-engine:latest`
3. **Service name:** `draftly-ai-worker`
4. **Region:** `us-central1`
5. **Authentication:** Require authentication (internal only)

**Container tab:**
- Container port: `8080`
- **Command:** (leave blank — uses the image's `start.sh` entrypoint)
- Add environment variable: `DRAFTLY_ROLE` = `worker` (this tells `start.sh` to launch Celery)
- CPU: `2`
- Memory: `1 GiB`
- Request timeout: `3600`
- Min instances: `1`
- Max instances: `3`

> **Why leave Command blank?** The `ai-engine/start.sh` entrypoint reads `DRAFTLY_ROLE`:
> - `worker` → starts uvicorn health server in background + launches Celery worker (correct for Cloud Run, which requires a process to bind the health-check port)
> - `api` → starts only uvicorn (for the standalone api service if needed)

**Variables & Secrets tab:**

Environment variables:
| Name | Value |
|------|-------|
| `DRAFTLY_ROLE` | `worker` |
| `DB_HOST` | `10.0.0.2` (Cloud SQL private IP) |
| `DB_PORT` | `5432` |
| `DB_NAME` | `draftly` |
| `DB_USER` | `draftly` |
| `REDIS_URL` | `redis://10.0.0.3:6379` (Memorystore IP) |
| `LLM_PRIMARY_MODEL` | `gemini/gemini-2.0-flash` (or whichever model you're using) |
| `LLM_FALLBACK_MODEL` | `gemini/gemini-1.5-flash` |
| `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` (if using OpenRouter) |
| `CELERY_QUEUES` | `triage-queue,draft-queue,profile-queue` |
| `CELERY_CONCURRENCY` | `4` |

Secrets (click "Reference a Secret"):
| Name | Secret | Version |
|------|--------|---------|
| `OPENAI_API_KEY` | `draftly-openrouter-api-key` | latest |
| `DB_PASSWORD` | `draftly-db-password` | latest |

**Networking tab:**
- Ingress: **Internal**
  > This controls *inbound* HTTP traffic to this Cloud Run service's URL only.
  > It does **not** block the worker's *outbound* calls to external APIs.
  > "Internal" is correct here — no external party should be able to invoke this service's HTTP endpoint directly.
- VPC connector: `draftly-connector`
- VPC egress: **"Route only requests to private IPs through the VPC connector"** ← **CRITICAL**
  > ⚠️ This setting controls *outbound* traffic routing:
  > - `10.x.x.x` (Cloud SQL, Memorystore) → routed through the VPC connector ✅
  > - `openrouter.ai`, `generativelanguage.googleapis.com`, `gmail.googleapis.com` → exit directly to internet ✅
  >
  > **Do NOT select "Route all traffic through VPC connector"** — your VPC has no Cloud NAT,
  > so all internet-bound traffic would be dropped, breaking LLM calls and Gmail API calls.

6. Click **"Create"**

### 6c: Deploy Frontend

1. Go to **Cloud Run** → **"Create Service"**
2. **Container image:** `us-central1-docker.pkg.dev/PROJECT_ID/draftly/frontend:latest`
3. **Service name:** `draftly-frontend`
4. **Region:** `us-central1`
5. **Authentication:** Allow unauthenticated invocations

**Container tab:**
- Container port: `3001`
- CPU: `1`
- Memory: `256 MiB`
- Min instances: `0` (scales to zero when no traffic)
- Max instances: `3`

**Networking tab:**
- Ingress: **All**
- No VPC connector needed (frontend doesn't access private resources)

6. Click **"Create"**

Note the frontend URL (e.g., `https://draftly-frontend-xyz789.run.app`).

## Step 7: Run Database Migrations

The database schema needs to be created. Use Cloud Shell:

1. Click the **Cloud Shell** icon (top-right terminal icon in GCP Console)
2. In Cloud Shell:

```bash
# Clone your repo
git clone YOUR_REPO_URL
cd draftly/gateway

# Install dependencies
npm install

# Set environment variables for migration
export DB_HOST=10.0.0.2      # Your Cloud SQL private IP
export DB_PORT=5432
export DB_NAME=draftly
export DB_USER=draftly
export DB_PASSWORD=your-db-password

# Run migrations
npm run migrate
```

> Note: Cloud Shell has access to your VPC via the default network. If it can't reach Cloud SQL directly, use the Cloud SQL Auth Proxy:
> ```bash
> # Download proxy
> curl -o cloud-sql-proxy https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.8.0/cloud-sql-proxy.linux.amd64
> chmod +x cloud-sql-proxy
> 
> # Start proxy (connects via Cloud SQL API, not VPC)
> ./cloud-sql-proxy PROJECT_ID:us-central1:draftly-db &
> 
> # Now use localhost:5432 for DB_HOST
> export DB_HOST=127.0.0.1
> npm run migrate
> ```

## Step 8: Post-Deployment Configuration

### Update CORS Origins

Now that you have the frontend URL, update the Gateway's `CORS_ORIGINS`:

1. Go to Cloud Run → `draftly-gateway` → **"Edit & Deploy New Revision"**
2. Variables tab → update `CORS_ORIGINS` to include the frontend URL
3. Click "Deploy"

### Update OAuth Redirect URIs

1. Go to **APIs & Services → Credentials** in GCP Console
2. Click your OAuth 2.0 Client ID
3. Add to **Authorized redirect URIs:**
   - `https://draftly-gateway-XXXXX.run.app/api/v1/auth/google/callback`
   - `https://draftly-gateway-XXXXX.run.app/api/v1/connections/callback`
4. Add to **Authorized JavaScript origins:**
   - `https://draftly-frontend-XXXXX.run.app`
5. Click "Save"

### Rebuild Frontend with Correct API URL

Now that you have the Gateway URL:

```bash
docker build \
  --build-arg VITE_API_URL=https://draftly-gateway-XXXXX.run.app \
  -t $REGISTRY/frontend:latest \
  ./frontend

docker push $REGISTRY/frontend:latest
```

Then redeploy the frontend in Cloud Run (click "Edit & Deploy New Revision" → just click Deploy with the latest image).

## Step 9: Verify Deployment

1. **Gateway health:** Visit `https://draftly-gateway-XXXXX.run.app/api/v1/health`
   - Should return `{"status": "ok"}` or similar
2. **Frontend:** Visit `https://draftly-frontend-XXXXX.run.app`
   - Should load the React app
3. **AI Worker:** Go to Cloud Run → `draftly-ai-worker` → **Logs** tab
   - Should show Celery worker started and connected to Redis
4. **Test login:** Click Login on the frontend → should redirect to Google OAuth

## Troubleshooting

| Issue | Likely Cause | Fix |
|-------|-------------|-----|
| Gateway can't connect to DB | VPC connector not attached or wrong IP | Check Networking tab in Cloud Run |
| AI Worker not processing jobs | Wrong Redis URL or worker not started | Check logs, verify REDIS_URL matches Memorystore IP |
| Frontend shows blank page | VITE_API_URL not set during build | Rebuild with correct --build-arg |
| OAuth redirect fails | Redirect URI not added to Google credentials | Update OAuth client in APIs & Services |
| 403 on secrets | Missing IAM role | Grant "Secret Manager Secret Accessor" to compute service account |
| Cloud SQL connection refused | Public IP disabled but not using VPC connector | Ensure VPC connector is attached and routing all traffic |

## Cleanup (When Done)

To stop all billing:

**Option A: Delete individual resources** (if you want to keep the project)
1. Delete Cloud Run services (stops billing immediately)
2. Delete Memorystore instance
3. Delete Cloud SQL instance
4. Delete VPC Connector
5. Delete Artifact Registry images

**Option B: Delete the entire project** (nuclear option)
1. Go to **IAM & Admin → Settings**
2. Click **"Shut Down"**
3. Confirm project deletion

Resources are recoverable for 30 days after project shutdown.
