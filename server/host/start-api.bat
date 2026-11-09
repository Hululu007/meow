@echo off
chcp 65001 >nul
title 猫窝 - 后端服务
cd /d %~dp0..
echo ================================================
echo  猫窝后端 API
echo  前端: http://127.0.0.1:5173
echo  接口: http://127.0.0.1:9979
echo ================================================
echo.

REM classes/ 是 javac 产物，不入库（.gitignore 已排除）。
REM 新 clone 或改过 java 后必须先编译，否则会 ClassNotFoundException。
if not exist "host\classes\ApiServer.class" (
  echo [提示] 未找到 host\classes\ApiServer.class，先编译...
  pushd host
  call build.bat
  popd
  if not exist "host\classes\ApiServer.class" (
    echo [错误] 编译失败，请检查上面的 javac 输出。
    pause
    exit /b 1
  )
)

java -Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8 -cp "host/classes;host/libs/*" ApiServer 9979
pause
