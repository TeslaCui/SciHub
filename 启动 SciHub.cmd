@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ASCII-only launcher: avoids cmd.exe code-page issues with Chinese text.
set "SCIHUB_PYTHON="
if exist "D:\LeStoreDownload\Anaconda\python.exe" set "SCIHUB_PYTHON=D:\LeStoreDownload\Anaconda\python.exe"

if not defined SCIHUB_PYTHON (
  where python.exe >nul 2>nul
  if not errorlevel 1 set "SCIHUB_PYTHON=python.exe"
)

if not defined SCIHUB_PYTHON (
  echo ERROR: Python 3 was not found.
  echo Install Python or update the Anaconda path in this launcher.
  pause
  exit /b 1
)

set "SCIHUB_URL=http://127.0.0.1:8770/"
powershell.exe -NoProfile -Command "try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8770/api/health' -TimeoutSec 2; if ($h.service -eq 'SciHub') { exit 0 } } catch {}; exit 1" >nul 2>nul
if not errorlevel 1 (
  echo SciHub is already running. Opening it in your browser...
  start "" "%SCIHUB_URL%"
  exit /b 0
)

echo Starting SciHub local service...
echo Keep this window open while using SciHub.
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 500; Start-Process '%SCIHUB_URL%'"
"%SCIHUB_PYTHON%" "%~dp0scihub_server.py"

echo.
echo SciHub service stopped.
pause
