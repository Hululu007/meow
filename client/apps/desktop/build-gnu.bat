@echo off
REM 构建 Tauri（GNU 工具链）。真正的逻辑在 build-gnu.ps1 里（含 MinGW 自动探测），
REM 这里只做一层转发，避免两处重复维护同一组环境变量。
REM
REM 用法与 ps1 一致：build-gnu.bat --bundles nsis
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-gnu.ps1" %*
if errorlevel 1 (
  echo [错误] 构建失败，见上面输出。
  pause
  exit /b 1
)
pause
