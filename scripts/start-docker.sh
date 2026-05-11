#!/bin/bash

# =============================================================
# Draftly -- Docker Full Stack Startup Script (Linux/macOS)
# =============================================================
# Usage:
#   ./scripts/start-docker.sh
#
# Flags:
#   --clean    Destroy volumes and start fresh (wipes all DB data)
#   --down     Tear everything down and exit
#   --logs     Follow logs after startup
# =============================================================

# Colors for output
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Helper functions
write_step() { echo -e "\n${CYAN}>> $1${NC}"; }
write_ok()   { echo -e "   [OK] $1"; }
write_warn() { echo -e "   ${YELLOW}[!!] $1${NC}"; }
write_fail() { echo -e "   ${RED}[ERR] $1${NC}"; }

# Determine script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Flags
CLEAN=false
DOWN=false
LOGS=false

for arg in "$@"; do
    case $arg in
        --clean) CLEAN=true ;;
        --down)  DOWN=true ;;
        --logs)  LOGS=true ;;
    esac
done

# ---- Tear Down ----------------------------------------------

if [ "$DOWN" = true ]; then
    write_step "Tearing down all Draftly containers..."
    docker compose down
    write_ok "All services stopped."
    exit 0
fi

if [ "$CLEAN" = true ]; then
    write_step "Clean mode -- removing all containers AND volumes (data will be lost)..."
    docker compose down -v --remove-orphans
    write_ok "Volumes removed. Starting fresh."
fi

# ---- Preflight Checks ---------------------------------------

echo -e "${MAGENTA}============================================="
echo -e "        Draftly Docker Startup               "
echo -e "=============================================${NC}"

# 1. Docker running?
write_step "Checking Docker..."
if ! docker info > /dev/null 2>&1; then
    write_fail "Docker is not running. Please start Docker engine first."
    exit 1
fi
write_ok "Docker is running."

# 2. .env file present?
write_step "Checking environment file..."
if [ ! -f ".env" ]; then
    write_fail ".env not found. Copy .env.example to .env and fill in your secrets:"
    echo "       cp .env.example .env"
    exit 1
fi
write_ok ".env found."

# 3. JWT Keys
write_step "Checking JWT keys..."
PRIV_KEY="gateway/keys/private.pem"
PUB_KEY="gateway/keys/public.pem"

if [ ! -f "$PRIV_KEY" ] || [ ! -f "$PUB_KEY" ]; then
    write_warn "JWT keys not found. Generating now..."
    cd gateway
    if [ ! -d "node_modules" ]; then
        write_warn "node_modules not found in gateway -- running npm ci..."
        npm ci
    fi
    node scripts/generate-keys.mjs
    cd ..
    if [ -f "$PRIV_KEY" ]; then
        write_ok "JWT keys generated at gateway/keys/"
    else
        write_fail "Key generation failed. Run manually: cd gateway && node scripts/generate-keys.mjs"
        exit 1
    fi
else
    write_ok "JWT keys present."
fi

# ---- Pull Base Images ----------------------------------------

write_step "Pulling base images (postgres, redis, pgbouncer)..."
docker pull postgres:16-alpine --quiet
docker pull redis:7-alpine --quiet
docker pull edoburu/pgbouncer:latest --quiet
write_ok "Base images up to date."

# ---- Build All Services -------------------------------------

write_step "Building Docker images for gateway, ai-engine, frontend..."
docker compose build --parallel
if [ $? -ne 0 ]; then
    write_fail "Build failed. Check the output above for errors."
    exit 1
fi
write_ok "All images built."

# ---- Start Infrastructure First -----------------------------

write_step "Starting infrastructure (postgres, redis, pgbouncer)..."
docker compose up -d postgres redis pgbouncer
if [ $? -ne 0 ]; then
    write_fail "Failed to start infrastructure services."
    exit 1
fi

# Wait for postgres to be healthy
write_step "Waiting for PostgreSQL to be ready..."
TIMEOUT=60
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
    HEALTH=$(docker inspect --format='{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)
    if [ "$HEALTH" == "healthy" ]; then
        write_ok "PostgreSQL is healthy."
        break
    fi
    sleep 3
    ELAPSED=$((ELAPSED + 3))
    echo "   ... waiting for postgres ($ELAPSED/$TIMEOUT s)"
done

if [ $ELAPSED -ge $TIMEOUT ]; then
    write_fail "PostgreSQL did not become healthy in time."
    docker compose logs postgres
    exit 1
fi

# ---- Run Migrations -----------------------------------------

write_step "Running database migrations (knex)..."
docker compose run --rm migrate
if [ $? -ne 0 ]; then
    write_fail "Migrations failed! Check logs above."
    exit 1
fi
write_ok "All migrations applied successfully."

# ---- Start All App Services ---------------------------------

write_step "Starting all application services..."
docker compose up -d gateway ai-engine-worker ai-engine-api celery-beat frontend
if [ $? -ne 0 ]; then
    write_fail "One or more services failed to start."
    docker compose ps
    exit 1
fi

# ---- Final Status -------------------------------------------

sleep 3

echo -e "\n${GREEN}============================================="
echo -e "        Draftly is running!                  "
echo -e "=============================================${NC}"
echo -e "\n  Service Endpoints:"
echo -e "  -----------------------------------------"
echo -e "  Frontend       -->  http://localhost:3001"
echo -e "  Gateway API    -->  http://localhost:3000"
echo -e "  AI Engine API  -->  http://localhost:8000"
echo -e "  PostgreSQL     -->  localhost:5432"
echo -e "  PgBouncer      -->  localhost:6432"
echo -e "  Redis          -->  localhost:6379"
echo -e "\n  Useful Commands:"
echo -e "  -----------------------------------------"
echo -e "  View all logs:       docker compose logs -f"
echo -e "  Stop everything:     ./scripts/start-docker.sh --down"
echo -e "  Wipe and restart:    ./scripts/start-docker.sh --clean"
echo -e ""

docker compose ps

if [ "$LOGS" = true ]; then
    echo -e "\n${CYAN}Following logs (Ctrl+C to stop)...${NC}\n"
    docker compose logs -f
fi
