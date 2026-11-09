@echo off
REM 启动桌面版（带远程调试端口）。窗口画面可通过 CDP 直接截屏 / 检查 DOM，
REM 不需要抓整屏，也不会受本机正在做别的事情影响。
REM
REM 用法：
REM   run-desktop-debug.bat           默认端口 9222
REM   run-desktop-debug.bat 9333      自定义端口
REM
REM 启动后可用：
REM   node apps\desktop\cdp.mjs shot out.png   —— 只截应用窗口
REM   node apps\desktop\cdp.mjs text           —— 读取页面文字（验证是否渲染成功）
REM   node apps\desktop\cdp.mjs eval "..."     —— 在页面里执行 JS
REM   node apps\desktop\cdp.mjs click "搜索"   —— 按文字点按钮
chcp 65001 >nul
setlocal

set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"

set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=%PORT% --remote-allow-origins=*"

set "ROOT=%~dp0"
set "EXE=%ROOT%apps\desktop\src-tauri\target\x86_64-pc-windows-gnu\release\meow-player.exe"
if not exist "%EXE%" (
  echo [错误] 未找到 %EXE%
  echo 请先运行 apps\desktop\build-gnu.ps1 构建。
  pause
  exit /b 1
)

echo ================================================
echo  影视仓 桌面版（调试模式）
echo  CDP 端口: http://127.0.0.1:%PORT%
echo  目标列表: http://127.0.0.1:%PORT%/json
echo  截图: node apps\desktop\cdp.mjs shot shot.png
echo ================================================
echo.

start "" "%EXE%"
echo 已启动，等待 WebView2 就绪...
timeout /t 4 >nul
curl -s http://127.0.0.1:%PORT%/json/version 2>nul
echo.
echo 现在可以直接在另一个终端使用 cdp.mjs。
pause
