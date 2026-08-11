@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在啟動進銷存 ERP...
echo 請保持本視窗開啟，然後瀏覽 http://127.0.0.1:3000/
npm.cmd start
pause
