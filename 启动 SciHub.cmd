@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ASCII-only launcher: avoids cmd.exe code-page issues with Chinese text.
rem Optional override: set SCIHUB_PYTHON to the full path of python.exe.
set "SCIHUB_URL=http://127.0.0.1:8770/"
set "SCIHUB_PYTHON_CONFIG=%~dp0.scihub-python.local"
set "SCIHUB_PYTHON_ARGS="
set "SCIHUB_PYTHON_IS_COMMAND="
set "SCIHUB_PYTHON_FROM_PROMPT="

rem A running SciHub does not need Python discovery.  Check this first so an
rem already-open app never gets blocked by a missing PATH entry for Python.
powershell.exe -NoProfile -Command "try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8770/api/health' -TimeoutSec 2; if ($h.service -eq 'SciHub') { exit 0 } } catch {}; exit 1" >nul 2>nul
if not errorlevel 1 (
  echo SciHub is already running. Opening it in your browser...
  start "" "%SCIHUB_URL%"
  exit /b 0
)

rem A manually chosen Python is local to this installation and is git-ignored.
if not defined SCIHUB_PYTHON if exist "%SCIHUB_PYTHON_CONFIG%" (
  set /p "SCIHUB_PYTHON="<"%SCIHUB_PYTHON_CONFIG%"
)

if defined SCIHUB_PYTHON if not exist "%SCIHUB_PYTHON%" (
  echo WARNING: The configured Python path does not point to an existing python.exe.
  set "SCIHUB_PYTHON="
)

if not defined SCIHUB_PYTHON (
  where py.exe >nul 2>nul
  if not errorlevel 1 (
    py.exe -3 -c "import sys; assert sys.version_info >= (3, 8)" >nul 2>nul
    if not errorlevel 1 (
      set "SCIHUB_PYTHON=py.exe"
      set "SCIHUB_PYTHON_ARGS=-3"
      set "SCIHUB_PYTHON_IS_COMMAND=1"
    )
  )
)

if not defined SCIHUB_PYTHON (
  where python.exe >nul 2>nul
  if not errorlevel 1 (
    python.exe -c "import sys; assert sys.version_info >= (3, 8)" >nul 2>nul
    if not errorlevel 1 (
      set "SCIHUB_PYTHON=python.exe"
      set "SCIHUB_PYTHON_IS_COMMAND=1"
    )
  )
)

if not defined SCIHUB_PYTHON (
  echo Python 3 was not found automatically.
  echo Paste the full path to this computer's python.exe, then press Enter.
  set /p "SCIHUB_PYTHON=Python path: "
  if defined SCIHUB_PYTHON set "SCIHUB_PYTHON_FROM_PROMPT=1"
)

if not defined SCIHUB_PYTHON (
  echo ERROR: Python 3 was not selected.
  echo Install Python 3, or set SCIHUB_PYTHON to the full path of python.exe.
  pause
  exit /b 1
)

if not defined SCIHUB_PYTHON_IS_COMMAND if not exist "%SCIHUB_PYTHON%" (
  echo ERROR: The selected Python path does not exist.
  echo Set SCIHUB_PYTHON to the full path of python.exe and try again.
  pause
  exit /b 1
)

if defined SCIHUB_PYTHON_FROM_PROMPT (
  > "%SCIHUB_PYTHON_CONFIG%" echo %SCIHUB_PYTHON%
  echo Saved this installation's Python path for future launches.
)

"%SCIHUB_PYTHON%" %SCIHUB_PYTHON_ARGS% -c "import pypdf, docx, reportlab" >nul 2>nul
if errorlevel 1 (
  echo ERROR: Document features need pypdf, python-docx and reportlab.
  echo Run: "%SCIHUB_PYTHON%" %SCIHUB_PYTHON_ARGS% -m pip install pypdf python-docx reportlab
  pause
  exit /b 1
)

echo Starting SciHub local service...
echo Keep this window open while using SciHub.
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 500; Start-Process '%SCIHUB_URL%'"
"%SCIHUB_PYTHON%" %SCIHUB_PYTHON_ARGS% "%~dp0scihub_server.py"

echo.
echo SciHub service stopped.
pause
