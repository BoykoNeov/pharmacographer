#!/usr/bin/env bash
# ===================================================================
#  Start Pharmacographer (Linux / macOS) — run to launch.
#  Reuses the dev server if this project is already being served, and only
#  starts a new one otherwise. Opens the app in your browser.
#  Educational use only — not medical advice.
#
#  Make it clickable once:  chmod +x start-pharmacographer.sh
#  Then double-click it (choose "Run" if your file manager asks) or
#  run  ./start-pharmacographer.sh  from a terminal.
# ===================================================================
set -euo pipefail

# Run from the folder this script lives in, whatever the working dir.
cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo
  echo "  Node.js / npm was not found on your PATH."
  echo "  Install Node.js from https://nodejs.org/ and try again."
  echo
  read -rp "  Press Enter to close..." _
  exit 1
fi

# Is one of our dev servers already up? Ask every port in Vite's range what it
# is SERVING, and only reuse a page that identifies itself as this app.
# Checking "is something on 5173" instead would be the same bug in a new
# costume: other Vite projects climb into this range, so 5173 is very often a
# different app and a naive check would hijack it.
#
# This runs BEFORE the node_modules check on purpose — if a server is already
# serving the app, there is nothing to install and nothing to start. `|| true`
# keeps a detector failure from tripping `set -e`: no URL just means we start
# a fresh server.
DEV_URL="$(node tools/find-dev-server.mjs 2>/dev/null || true)"

if [ -n "$DEV_URL" ]; then
  echo
  echo "  Pharmacographer is already running at $DEV_URL"
  echo "  Opening that one — no second server started."
  echo
  echo "  It is serving your current code: Vite reads from disk on every"
  echo "  request, so even a server left up for days is up to date. The one"
  echo "  exception is a change to vite.config.ts — for that, stop the old"
  echo "  server (Ctrl+C in its terminal) and run this again to start fresh."
  echo
  if command -v open >/dev/null 2>&1; then
    open "$DEV_URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$DEV_URL"
  else
    echo "  Open that URL in your browser."
  fi
  exit 0
fi

if [ ! -d node_modules ]; then
  echo
  echo "  First run: installing dependencies (this happens once)..."
  echo
  npm install
fi

echo
echo "  Starting Pharmacographer..."
echo "  Your browser will open automatically. Leave this window open."
echo "  Press Ctrl+C to stop the app."
echo

# `--open` launches the default browser at the dev URL.
npm run dev -- --open
