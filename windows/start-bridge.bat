@echo off
rem LabXpro Bridge: run in this window (close the window to stop). For automatic start use install-autostart.
cd /d "%~dp0"
if not exist bridge.config.json (
  echo bridge.config.json not found. Copy bridge.config.example.json to bridge.config.json and paste your machine keys.
  pause
  exit /b 1
)
echo Status page: http://localhost:4545
node.exe src\main.js bridge.config.json
pause
