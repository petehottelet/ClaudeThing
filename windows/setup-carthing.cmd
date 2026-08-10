@echo off
rem Car Thing AI Usage Dashboard - Windows setup.
rem Double-click this file. It ensures Node exists, then hands off to the
rem cross-platform orchestrator at setup\setup.mjs.
rem
rem Windows performs the host install and, when the device is already in
rem ADB mode, the deploy. The one-time burn-mode unlock/backup requires a
rem Mac or Linux machine (unreliable Windows USB drivers for that mode).

setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node is not installed. Installing via winget...
  winget install --id OpenJS.NodeJS.LTS -e --silent
  if errorlevel 1 (
    echo Could not install Node automatically. Install Node from nodejs.org and re-run.
    pause
    exit /b 1
  )
  echo Node installed. Close this window and run this file again so PATH refreshes.
  pause
  exit /b 0
)

node setup\setup.mjs %*
pause
