# =============================================================
# Draftly -- Docker Full Stack Startup Script
# =============================================================
# Usage (from project root):
#   .\scripts\start-docker.ps1
#
# Flags:
#   -Clean     Destroy volumes and start fresh (wipes all DB data)
#   -Down      Tear everything down and exit
#   -Logs      Follow logs after startup
# =============================================================

param(
    [switch]$Clean,
    [switch]$Down,
    [switch]$Logs
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Set-Location $ProjectRoot

# ---- Helpers ------------------------------------------------

function Write-Step($msg) { Write-Host "" ; Write-Host ">> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "   [!!] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "   [ERR] $msg" -ForegroundColor Red }

# ---- Tear Down ----------------------------------------------

if ($Down) {
    Write-Step "Tearing down all Draftly containers..."
    docker compose down
    Write-Ok "All services stopped."
    exit 0
}

if ($Clean) {
    Write-Step "Clean mode -- removing all containers AND volumes (data will be lost)..."
    docker compose down -v --remove-orphans
    Write-Ok "Volumes removed. Starting fresh."
}

# ---- Preflight Checks ---------------------------------------

Write-Host ""
Write-Host "=============================================" -ForegroundColor Magenta
Write-Host "        Draftly Docker Startup               " -ForegroundColor Magenta
Write-Host "=============================================" -ForegroundColor Magenta

# 1. Docker running?
Write-Step "Checking Docker..."
$oldErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$dockerInfo = docker info 2>$null
$ErrorActionPreference = $oldErrorActionPreference

if ($LASTEXITCODE -ne 0) {
    Write-Fail "Docker is not running. Please start Docker Desktop first."
    exit 1
}
Write-Ok "Docker is running."

# 2. .env file present?
Write-Step "Checking environment file..."
if (-not (Test-Path "$ProjectRoot\.env")) {
    Write-Fail ".env not found. Copy .env.example to .env and fill in your secrets:"
    Write-Host "       copy .env.example .env" -ForegroundColor Gray
    exit 1
}
Write-Ok ".env found."

# 3. JWT Keys
Write-Step "Checking JWT keys..."
$privKey = "$ProjectRoot\gateway\keys\private.pem"
$pubKey  = "$ProjectRoot\gateway\keys\public.pem"

if (-not (Test-Path $privKey) -or -not (Test-Path $pubKey)) {
    Write-Warn "JWT keys not found. Generating now..."
    Set-Location "$ProjectRoot\gateway"

    if (-not (Test-Path "node_modules")) {
        Write-Warn "node_modules not found in gateway -- running npm ci..."
        npm ci
    }

    node scripts/generate-keys.mjs
    Set-Location $ProjectRoot

    if (Test-Path $privKey) {
        Write-Ok "JWT keys generated at gateway/keys/"
    } else {
        Write-Fail "Key generation failed. Run manually: cd gateway && node scripts/generate-keys.mjs"
        exit 1
    }
} else {
    Write-Ok "JWT keys present."
}

# ---- Pull Base Images ----------------------------------------

Write-Step "Pulling base images (postgres, redis, pgbouncer)..."
docker pull postgres:16-alpine  --quiet
docker pull redis:7-alpine      --quiet
docker pull edoburu/pgbouncer:latest --quiet
Write-Ok "Base images up to date."

# ---- Build All Services -------------------------------------

Write-Step "Building Docker images for gateway, ai-engine, frontend..."
docker compose build --parallel
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Build failed. Check the output above for errors."
    exit 1
}
Write-Ok "All images built."

# ---- Start Infrastructure First -----------------------------

Write-Step "Starting infrastructure (postgres, redis, pgbouncer)..."
docker compose up -d postgres redis pgbouncer
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Failed to start infrastructure services."
    exit 1
}

# Wait for postgres to be healthy
Write-Step "Waiting for PostgreSQL to be ready..."
$timeout = 60
$elapsed = 0
while ($elapsed -lt $timeout) {
    $containerId = docker compose ps -q postgres 2>$null
    if ($containerId) {
        $health = docker inspect --format="{{.State.Health.Status}}" $containerId 2>$null
        if ($health -eq "healthy") {
            Write-Ok "PostgreSQL is healthy."
            break
        }
    }
    Start-Sleep 3
    $elapsed += 3
    Write-Host "   ... waiting for postgres ($elapsed/$timeout s)" -ForegroundColor Gray
}

if ($elapsed -ge $timeout) {
    Write-Fail "PostgreSQL did not become healthy in time."
    docker compose logs postgres
    exit 1
}

# ---- Run Migrations -----------------------------------------

Write-Step "Running database migrations (all 16 knex migrations)..."
docker compose run --rm migrate
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Migrations failed! Check logs above."
    exit 1
}
Write-Ok "All migrations applied successfully."

# ---- Start All App Services ---------------------------------

Write-Step "Starting all application services..."
docker compose up -d gateway ai-engine-worker ai-engine-api celery-beat frontend
if ($LASTEXITCODE -ne 0) {
    Write-Fail "One or more services failed to start."
    docker compose ps
    exit 1
}

# ---- Final Status -------------------------------------------

Start-Sleep 3

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "        Draftly is running!                  " -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Service Endpoints:" -ForegroundColor White
Write-Host "  -----------------------------------------" -ForegroundColor DarkGray
Write-Host "  Frontend       -->  http://localhost:3001" -ForegroundColor White
Write-Host "  Gateway API    -->  http://localhost:3000" -ForegroundColor White
Write-Host "  AI Engine API  -->  http://localhost:8000" -ForegroundColor White
Write-Host "  PostgreSQL     -->  localhost:5432" -ForegroundColor White
Write-Host "  PgBouncer      -->  localhost:6432" -ForegroundColor White
Write-Host "  Redis          -->  localhost:6379" -ForegroundColor White
Write-Host ""
Write-Host "  Useful Commands:" -ForegroundColor White
Write-Host "  -----------------------------------------" -ForegroundColor DarkGray
Write-Host "  View all logs:       docker compose logs -f" -ForegroundColor Gray
Write-Host "  View one service:    docker compose logs -f gateway" -ForegroundColor Gray
Write-Host "  Stop everything:     .\scripts\start-docker.ps1 -Down" -ForegroundColor Gray
Write-Host "  Wipe and restart:    .\scripts\start-docker.ps1 -Clean" -ForegroundColor Gray
Write-Host "  Re-run migrations:   docker compose run --rm migrate" -ForegroundColor Gray
Write-Host ""

docker compose ps

if ($Logs) {
    Write-Host ""
    Write-Host "Following logs (Ctrl+C to stop)..." -ForegroundColor Cyan
    Write-Host ""
    docker compose logs -f
}
