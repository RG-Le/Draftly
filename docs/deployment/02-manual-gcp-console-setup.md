# Manual GCP Console Setup — Step by Step

This guide walks you through provisioning all GCP infrastructure from the Google Cloud Console UI. No CLI required.

## Prerequisites

- GCP account with billing enabled (free $300 credits work)
- Your `.env` file with all secrets ready locally
- Basic familiarity with web UIs

## Step 1: Create a GCP Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click the project dropdown (top-left, next to "Google Cloud")
3. Click **"New Project"**
4. Project name: `draftly-prod` (or your preference)
5. Note the **Project ID** (auto-generated, you'll need it everywhere)
6. Click **"Create"**
7. Select the new project from the dropdown to make it active

## Step 2: Enable Required APIs

Navigate to **APIs & Services → Library** (left sidebar).

Search for and enable each of these APIs (click the API → click "Enable"):

| # | API Name | Why Needed |
|---|----------|-----------|
| 1 | Cloud Run Admin API | Deploy containers |
| 2 | Cloud SQL Admin API | Managed PostgreSQL |
| 3 | Google Cloud Memorystore for Redis API | Managed Redis |
| 4 | Secret Manager API | Store secrets securely |
| 5 | Artifact Registry API | Store Docker images |
| 6 | Cloud Build API | CI/CD pipeline |
| 7 | Serverless VPC Access API | Private networking |
| 8 | Compute Engine API | VPC networking foundation |

Each takes a few seconds to enable. Wait for confirmation before moving on.

## Step 3: Create VPC Network

This is the private network where your database and Redis live.

1. Navigate to **VPC Network → VPC Networks** (left sidebar)
2. Click **"Create VPC Network"**
3. Configure:
   - Name: `draftly-vpc`
   - Subnet creation mode: **Custom**
4. Add a subnet:
   - Subnet name: `draftly-subnet`
   - Region: `us-central1`
   - IP address range: `10.0.0.0/24`
5. Leave firewall rules as default
6. Click **"Create"**

Wait ~30 seconds for creation.

## Step 4: Create Serverless VPC Access Connector

This bridges Cloud Run (serverless) with your private VPC resources.

1. Search for **"Serverless VPC Access"** in the top search bar
2. Click **"Create Connector"**
3. Configure:
   - Name: `draftly-connector`
   - Region: `us-central1` (MUST match your other resources)
   - Network: `draftly-vpc`
   - Subnet: **Custom IP range**
   - IP range: `10.8.0.0/28`
   - Min instances: `2`
   - Max instances: `3`
   - Machine type: `e2-micro`
4. Click **"Create"**

Wait ~2 minutes for the connector to become "Ready".

## Step 5: Create Cloud SQL Instance (PostgreSQL)

1. Navigate to **SQL** (left sidebar)
2. Click **"Create Instance"** → Choose **PostgreSQL**
3. Configure:
   - Instance ID: `draftly-db`
   - Password: set a strong password (**save this — you'll need it for Secret Manager**)
   - Database version: **PostgreSQL 16**
   - Choose configuration preset: **Development** (cheapest)
   - Region: `us-central1`
   - Zonal availability: Single zone (cheapest for demo)
4. Machine configuration:
   - Machine type: **Shared core → db-f1-micro**
5. Storage:
   - Storage type: SSD
   - Storage capacity: 10 GB
6. Connections:
   - **Uncheck** "Public IP"
   - **Check** "Private IP"
   - Network: `draftly-vpc`
   - If prompted to "Set up connection" or "Allocate IP range" → click it and accept defaults
7. Data protection:
   - **Enable** automated backups
   - Backup retention: 7 days
   - Enable point-in-time recovery: optional (adds cost)
8. Click **"Create Instance"**

**Wait 5-10 minutes** for provisioning to complete.

### After Instance is Created:

**Create the database:**
1. Click on the `draftly-db` instance
2. Go to **"Databases"** tab
3. Click **"Create Database"**
4. Database name: `draftly`
5. Click "Create"

**Create the application user:**
1. Go to **"Users"** tab
2. Click **"Add User Account"**
3. Username: `draftly`
4. Password: (use the same password or a different one — your choice)
5. Click "Add"

**Note the Private IP address** (shown on the Overview page, e.g., `10.0.0.2`) — you'll need this for Cloud Run environment variables.

**Connection Limits:** The db-f1-micro tier supports ~25 concurrent connections. For load testing with 300 concurrent users, upgrade to db-g1-small (500 max connections) or add a PgBouncer sidecar. For normal operation at 100-1000 users with the Gateway's Knex pool (max 20 per instance), db-f1-micro is sufficient for initial deployment but tight under load.

## Step 6: Create Memorystore Instance (Redis)

1. Search for **"Memorystore"** in the top search bar → select **"Memorystore for Redis"**
2. Click **"Create Instance"**
3. Configure:
   - Instance ID: `draftly-redis`
   - Tier: **Basic** (no replication, cheapest)
   - Capacity: **1 GB**
   - Region: `us-central1`
   - Zone: any
   - Redis version: **7.x** (or latest available)
   - Authorized network: `draftly-vpc`
4. Click **"Create"**

**Wait 3-5 minutes** for provisioning.

**Note the IP address** (shown on the instance details page, e.g., `10.0.0.3`) — you'll need this for Cloud Run environment variables.

Your Redis URL will be: `redis://10.0.0.3:6379`

## Step 7: Create Artifact Registry Repository

This stores your Docker images.

1. Navigate to **Artifact Registry** (left sidebar)
2. Click **"Create Repository"**
3. Configure:
   - Name: `draftly`
   - Format: **Docker**
   - Mode: Standard
   - Location type: Region
   - Region: `us-central1`
4. Click **"Create"**

Your image path pattern will be:
```
us-central1-docker.pkg.dev/YOUR_PROJECT_ID/draftly/IMAGE_NAME:TAG
```

## Step 8: Store Secrets in Secret Manager

1. Navigate to **Secret Manager** (search in top bar)
2. For each secret below, click **"Create Secret"**:

| Secret Name | What to Put as Value |
|-------------|---------------------|
| `draftly-google-client-id` | Your Google OAuth Client ID |
| `draftly-google-client-secret` | Your Google OAuth Client Secret |
| `draftly-encryption-key` | Your 64-character hex SECRET_ENCRYPTION_KEY |
| `draftly-gemini-api-key` | Your Gemini API key |
| `draftly-db-password` | The Cloud SQL password from Step 5 |

For each:
1. Click "Create Secret"
2. Name: (from table above)
3. Secret value: paste the value
4. Click "Create Secret"

**Optional but recommended:** Also store JWT keys:
- `draftly-jwt-private-key` — contents of your `gateway/keys/private.pem`
- `draftly-jwt-public-key` — contents of your `gateway/keys/public.pem`

## Step 9: Grant Cloud Run Access to Secrets

Cloud Run needs permission to read secrets.

1. Go to **IAM & Admin → IAM** (left sidebar)
2. Find the service account: `PROJECT_NUMBER-compute@developer.gserviceaccount.com`
   - (This is the default Compute Engine service account used by Cloud Run)
3. Click the pencil icon to edit
4. Add role: **Secret Manager Secret Accessor**
5. Click "Save"

This allows all Cloud Run services to read secrets from Secret Manager.

## Summary of Resources Created

| Resource | Name | Key Info |
|----------|------|----------|
| Project | draftly-prod | Note the Project ID |
| VPC | draftly-vpc | Subnet: 10.0.0.0/24 |
| VPC Connector | draftly-connector | IP: 10.8.0.0/28 |
| Cloud SQL | draftly-db | Private IP: (note it) |
| Database | draftly | On draftly-db instance |
| DB User | draftly | Password in Secret Manager |
| Memorystore | draftly-redis | Private IP: (note it) |
| Artifact Registry | draftly | Docker format, us-central1 |
| Secrets | 5-7 secrets | In Secret Manager |

## What's Next

With infrastructure provisioned, proceed to [Build and Deploy Services](./03-build-and-deploy-services.md) to push your Docker images and deploy Cloud Run services.
