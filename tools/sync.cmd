@echo off
REM ── SciHub 一键同步（在资源管理器里双击本文件即可）──────────
REM 实际交给 tools/sync.sh：语法检查 → 提交 → 推送（直连失败会自动走代理）
chcp 65001 >nul
cd /d "%~dp0.."

set "BASH="
where bash >nul 2>nul && set "BASH=bash"
if not defined BASH (
  for %%D in (
    "%ProgramFiles%\Git\bin"
    "%ProgramFiles(x86)%\Git\bin"
    "%LOCALAPPDATA%\Programs\Git\bin"
  ) do if exist "%%~D\bash.exe" set "BASH=%%~D\bash.exe"
)

if not defined BASH (
  echo.
  echo [错误] 找不到 Git Bash。请先安装 Git for Windows: https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

echo 使用：%BASH%
echo.
"%BASH%" tools/sync.sh %*

if errorlevel 1 (
  echo.
  echo [失败] 同步未完成，请把上面的输出发给开发者。
) else (
  echo.
  echo [完成] 已同步到 GitHub。
)
echo.
pause
