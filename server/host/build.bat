@echo off
cd /d %~dp0
if not exist classes mkdir classes
REM 用 sources.gen.txt 而不是 sources.txt：后者是**入库**的编译清单
REM （仓库根目录 javac @server/host/sources.txt 用的，路径相对仓库根）。
REM 这里生成的是相对 host/ 的 Windows 反斜杠路径，覆盖会毁掉那份清单。
dir /s /b src\*.java > sources.gen.txt
javac -encoding UTF-8 -cp "libs/*" -d classes @sources.gen.txt
if errorlevel 1 (echo BUILD FAILED) else (echo BUILD OK)
del sources.gen.txt
pause
