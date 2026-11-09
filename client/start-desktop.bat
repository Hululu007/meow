@echo off
chcp 65001 >nul
title 猫窝 - 桌面版
cd /d %~dp0apps\desktop
echo 启动桌面应用（开发模式，后端由插件管理器拉起）
echo 需要独立后端时另开：server\host\start-api.bat
echo.
call pnpm tauri dev
pause
