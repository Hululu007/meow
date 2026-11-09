@echo off
rem 计划任务入口：每 10 分钟清一次"跑了 90 分钟以上还在"的测试浏览器。
rem 只匹配 --user-data-dir 指向仓库 tmp\ 的实例，不碰用户自己的 Edge。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-test-edge.ps1" -Kill -OlderThanMinutes 90 -RemoveProfiles
