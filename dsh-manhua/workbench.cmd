@echo off
REM 漫剧工作台主入口
cd /d "%~dp0"
echo.
echo  启动漫剧工作台...
echo  打开后请用浏览器访问终端里打印的地址（默认 http://127.0.0.1:3780）
echo.
call pnpm workbench
