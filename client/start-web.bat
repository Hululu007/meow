@echo off
chcp 65001 >nul
title 猫窝 - 前端
cd /d %~dp0
echo ================================================
echo  猫窝 Web 前端（Vite 5173，/api 代理到 127.0.0.1:9979）
echo  请确保后端已启动（client\..\server\host\start-api.bat）
echo ================================================
echo.
call pnpm dev
pause
