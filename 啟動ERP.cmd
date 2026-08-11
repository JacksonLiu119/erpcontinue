@echo off
setlocal
cd /d "%~dp0"
if not exist "package.json" exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if(-not $p){Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden; Start-Sleep -Seconds 3}; Start-Process 'http://127.0.0.1:3000/'"
endlocal
