@echo off
chcp 65001 >nul
title SciHub 科研知识工作台
cd /d "%~dp0"

echo ============================================
echo   SciHub 科研知识工作台 - 本地服务
echo ============================================
echo.

where python >nul 2>nul
if %errorlevel%==0 (
  set "PY=python"
) else (
  where py >nul 2>nul
  if %errorlevel%==0 (
    set "PY=py"
  ) else (
    echo [错误] 未检测到 Python。请先安装 Python 3，并在安装时勾选 "Add to PATH"。
    echo 下载地址：https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
  )
)

echo 正在启动本地服务，浏览器将自动打开工作台。
echo 数据会保存到本文件夹下的「科研项目」目录，均为 .md 文件。
echo 关闭此窗口即停止服务。
echo.

%PY% scihub_server.py

echo.
echo 服务已停止。
pause
