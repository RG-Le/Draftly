@echo off
echo Setting up AI Engine Virtual Environment...

:: Navigate to the ai-engine directory if not already there
cd /d "%~dp0"

:: Create virtual environment if it doesn't exist
if not exist ".venv" (
    echo Creating .venv...
    python -m venv .venv
)

:: Activate the virtual environment
echo Activating virtual environment...
call .venv\Scripts\activate.bat

:: Upgrade pip
echo Upgrading pip...
python -m pip install --upgrade pip

:: Install all project dependencies (including uvicorn and celery)
echo Installing dependencies from requirements.txt...
pip install -r requirements.txt

:: Optionally install poetry and run install if users prefer poetry workflow later
:: pip install poetry
:: poetry install

echo.
echo Setup Complete! 
echo ---------------------------------------------------------
echo To run the Celery worker, ensure your venv is activated:
echo   call .venv\Scripts\activate.bat
echo   celery -A src.celery_app worker --loglevel=info --concurrency=4 --queues=triage-queue,draft-queue,profile-queue
echo.
echo To run the API:
echo   call .venv\Scripts\activate.bat
echo   uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
echo ---------------------------------------------------------
pause
