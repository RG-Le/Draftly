@echo off
setlocal

cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=3001"

if "%PORT%"=="3000" goto :reserved
if "%PORT%"=="5432" goto :reserved
if "%PORT%"=="6379" goto :reserved
if "%PORT%"=="6432" goto :reserved
if "%PORT%"=="8000" goto :reserved

netstat -ano | findstr LISTENING | findstr /R /C:":%PORT% " >nul
if %errorlevel%==0 (
  echo Port %PORT% is already in use. Stop the existing process or pick another port.
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo Created .env from .env.example
  )
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
)

echo Starting Draftly frontend at http://localhost:%PORT% ...
if not "%PORT%"=="3001" (
  echo Note: if API CORS is restricted to localhost:3001, add localhost:%PORT% in gateway CORS_ORIGINS.
  call npm run dev -- --port %PORT% --strictPort
) else (
  call npm run dev
)

endlocal
goto :eof

:reserved
echo Port %PORT% is reserved by backend/infrastructure services. Use another frontend port.
exit /b 1
