#!/usr/bin/env bash
# ===================================================================
#  Start Pharmacographer (Linux / macOS) — run to launch.
#  Starts the local dev server and opens the app in your browser.
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
