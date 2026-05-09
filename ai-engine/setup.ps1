Write-Host "Setting up AI Engine Virtual Environment..." -ForegroundColor Cyan

# Navigate to the ai-engine directory if not already there
Set-Location -Path $PSScriptRoot

# Create virtual environment if it doesn't exist
if (-not (Test-Path ".venv")) {
    Write-Host "Creating .venv..." -ForegroundColor Yellow
    python -m venv .venv
}

# Activate the virtual environment
Write-Host "Activating virtual environment..." -ForegroundColor Yellow
$env:Path = "$PSScriptRoot\.venv\Scripts;" + $env:Path
$env:VIRTUAL_ENV = "$PSScriptRoot\.venv"

# Upgrade pip
Write-Host "Upgrading pip..." -ForegroundColor Yellow
python -m pip install --upgrade pip

# Install all project dependencies (including uvicorn and celery)
Write-Host "Installing dependencies from requirements.txt..." -ForegroundColor Yellow
pip install -r requirements.txt

# Optionally install poetry and run install if users prefer poetry workflow later
# pip install poetry
# poetry install

Write-Host ""
Write-Host "Setup Complete!" -ForegroundColor Green
Write-Host "---------------------------------------------------------" -ForegroundColor Cyan
Write-Host "To run the Celery worker, ensure your venv is activated:"
Write-Host "  .venv\Scripts\Activate.ps1" -ForegroundColor Yellow
Write-Host "  celery -A src.celery_app worker --loglevel=info --concurrency=4 --queues=triage-queue,draft-queue,profile-queue" -ForegroundColor Yellow
Write-Host ""
Write-Host "To run the API:"
Write-Host "  .venv\Scripts\Activate.ps1" -ForegroundColor Yellow
Write-Host "  uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload" -ForegroundColor Yellow
Write-Host "---------------------------------------------------------" -ForegroundColor Cyan
