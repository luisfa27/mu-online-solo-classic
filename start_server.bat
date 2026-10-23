@echo off
title MU Online Solo Classic - Server
echo Starting MU Online Solo Classic local server...
start http://localhost:8088/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0web\serve.ps1"
pause
