@echo off
REM 启动后端：ApiServer 才是完整实现（多站点、聚合搜索、弹幕、WebDAV、DoH）。
REM SpiderHost 是早期精简版，HTTP 路由很少，不要再使用。
cd /d %~dp0
REM classes/ 是 javac 产物，不入库。缺了就现编。
if not exist "classes\ApiServer.class" (
  echo [提示] 未找到 classes\ApiServer.class，先编译...
  call build.bat
)
java -Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8 -cp "classes;libs/*" ApiServer 9979
pause
