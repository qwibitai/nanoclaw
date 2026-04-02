#!/bin/bash
# Start a Göran project locally on your machine
# Usage: bash scripts/dev.sh <project-name> [port]
# Example: bash scripts/dev.sh nanoclaw-dashboard 3333

PROJECT=$1
PORT=${2:-3000}
DIR="/Users/freddyk/github/goran/$PROJECT"

if [ -z "$PROJECT" ]; then
  echo "Usage: bash scripts/dev.sh <project-name> [port]"
  echo ""
  echo "Available projects:"
  ls /Users/freddyk/github/goran/
  exit 1
fi

if [ ! -d "$DIR" ]; then
  echo "Project not found: $DIR"
  exit 1
fi

cd "$DIR"

# Clean container node_modules (Linux binaries) and reinstall for macOS
if [ -d "node_modules" ]; then
  echo "Cleaning container node_modules (Linux binaries)..."
  rm -rf node_modules .next
fi

echo "Installing dependencies for macOS..."
npm install

echo ""
echo "Starting dev server on http://localhost:$PORT"
npx next dev -p "$PORT"
