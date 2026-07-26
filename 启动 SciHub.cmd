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

echo Starting SciHub local service...
echo Keep this window open while using SciHub.
"%SCIHUB_PYTHON%" "%~dp0scihub_server.py"

echo.
echo SciHub service stopped.
pause
