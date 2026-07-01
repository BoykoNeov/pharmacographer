@echo off
REM ===================================================================
REM  Start Pharmacographer (Windows) — double-click to launch.
REM  Starts the local dev server and opens the app in your browser.
REM  Educational use only — not medical advice.
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
