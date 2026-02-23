#!/usr/bin/env bash
# Start the standalone JarvisApp and bind it to this NanoClaw workspace.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
JARVISAPP_DIR="${JARVISAPP_DIR:-$HOME/Documents/remote-claude/jarvisapp-mac}"
LAUNCHER="$JARVISAPP_DIR/start-jarvisapp.sh"
APP_BUILD_DIR="$JARVISAPP_DIR/JarvisApp/.build"

if [ ! -x "$LAUNCHER" ]; then
  echo "❌ JarvisApp launcher not found or not executable:"
  echo "   $LAUNCHER"
  echo
  echo "Set JARVISAPP_DIR if your JarvisApp repo is in a different location."
  exit 1
fi

echo "◆ Starting JarvisApp from: $JARVISAPP_DIR"
echo "◆ Using NanoClaw root: $NANOCLAW_ROOT"
echo "◆ Clearing stale build cache: $APP_BUILD_DIR"
rm -rf "$APP_BUILD_DIR"

NANOCLAW_ROOT="$NANOCLAW_ROOT" "$LAUNCHER"

APP_BUNDLE="$JARVISAPP_DIR/JarvisApp/.build/debug/JarvisApp.app"

if [ -d "$APP_BUNDLE" ]; then
  echo "◆ Launching via macOS open: $APP_BUNDLE"
  open "$APP_BUNDLE"
fi
