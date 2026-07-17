@echo off
REM ===================================================================
REM  Start Pharmacographer (Windows) - double-click to launch.
REM  Reuses the dev server if this project is already being served, and
REM  only starts a new one otherwise. Opens the app in your browser.
REM  Educational use only - not medical advice.
REM ===================================================================

REM Run from the folder this script lives in, whatever the working dir.
cd /d "%~dp0"

title Pharmacographer

where npm >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js / npm was not found on your PATH.
  echo   Install Node.js from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

REM Is one of our dev servers already up? Ask every port in Vite's range what
REM it is SERVING, and only reuse a page that identifies itself as this app.
REM Checking "is something on 5173" instead would be the same bug in a new
REM costume: other Vite projects climb into this range, so 5173 is very often
REM a different app and a naive check would hijack it.
REM
REM This runs BEFORE the node_modules check on purpose - if a server is
REM already serving the app, there is nothing to install and nothing to start.
REM It runs AFTER the npm check above, which has already reported a missing
REM Node and exited. `set "VAR="` first so a stale value from the environment
REM cannot leak in; if the detector fails anyway it prints nothing, which
REM reads as "none running" and we simply start a fresh server.
set "DEV_URL="
for /f "usebackq delims=" %%u in (`node "tools\find-dev-server.mjs" 2^>nul`) do set "DEV_URL=%%u"

if defined DEV_URL (
  echo.
  echo   Pharmacographer is already running at %DEV_URL%
  echo   Opening that one - no second server started.
  echo.
  echo   It is serving your current code: Vite reads from disk on every
  echo   request, so even a server left up for days is up to date. The one
  echo   exception is a change to vite.config.ts - for that, close the old
  echo   server's window and run this again to start fresh.
  echo.
  REM The empty "" is the window-title argument. Without it, `start` reads the
  REM URL as the title and opens nothing.
  start "" "%DEV_URL%"
  echo   Press any key to close this window ^(the app keeps running^).
  pause >nul
  exit /b 0
)

if not exist "node_modules" (
  echo.
  echo   First run: installing dependencies ^(this happens once^)...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Dependency install failed. See the messages above.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   Starting Pharmacographer...
echo   Your browser will open automatically. Leave this window open.
echo   Close this window ^(or press Ctrl+C^) to stop the app.
echo.

REM `--open` launches the default browser at the dev URL.
call npm run dev -- --open

REM If the server exits (or fails to start) keep the window up so the
REM user can read any error message.
echo.
pause
