@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 清掉这个环境变量，否则 Electron 会退化成普通 Node，窗口不会出现
set "ELECTRON_RUN_AS_NODE="

echo.
echo   HT记账 正在启动，请稍候...
echo   （第一次启动需要编译，大约 10 秒）
echo.
echo   看到窗口后，关闭这个黑窗口不会关掉软件；
echo   关掉软件窗口后，这个黑窗口会自动提示你可以关闭它。
echo.

call npm run dev

echo.
echo   软件已退出。
pause
