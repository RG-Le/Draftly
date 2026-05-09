param(
  [switch]$SkipInstall,
  [int]$Port = 3001
)

$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

$reservedPorts = @(3000, 5432, 6379, 6432, 8000)
if ($reservedPorts -contains $Port) {
  throw "Port $Port is reserved by backend/infrastructure services. Use a different frontend port."
}

$portInUse = netstat -ano | Select-String -Pattern "LISTENING\s+\d+$" | Where-Object { $_.Line -match "[:\.]$Port\s" }
if ($portInUse) {
  throw "Port $Port is already in use. Stop the existing process or choose another port."
}

if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example"
}

if (-not $SkipInstall -and -not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..."
  npm install
}

Write-Host "Starting Draftly frontend at http://localhost:$Port ..."
if ($Port -ne 3001) {
  Write-Host "Note: if API CORS is restricted to localhost:3001, update gateway CORS_ORIGINS to include localhost:$Port."
  npm run dev -- --port $Port --strictPort
} else {
  npm run dev
}
