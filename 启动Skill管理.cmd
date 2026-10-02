@echo off
cd /d "%~dp0"
node scripts\check-env.mjs
if errorlevel 1 goto failed
node server.mjs --open
if errorlevel 1 goto failed
exit /b 0
:failed
pause
exit /b 1
