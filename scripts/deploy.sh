#!/bin/bash
set -e

SLUG=$1
APP=$2
DATA_DIR="${3:-../nexus-data}"

if [ -z "$SLUG" ] || [ -z "$APP" ]; then
  echo "Usage: scripts/deploy.sh <operator-slug> <fly-app> [data-dir]"
  echo "  e.g. scripts/deploy.sh foundry simt-nexus-mgf"
  echo "  e.g. scripts/deploy.sh bec simt-nexus-bec"
  exit 1
fi

OPERATOR_DIR="$DATA_DIR/operators/$SLUG"

if [ ! -d "$OPERATOR_DIR" ]; then
  echo "Error: operator data not found at $OPERATOR_DIR"
  exit 1
fi

echo "Deploying $APP (operator: $SLUG)"
echo "  Operator data: $OPERATOR_DIR"

# Stage only this operator's data for the Docker build
rm -rf .build-data
mkdir -p ".build-data/operators/$SLUG"
# Copy operator config files only (not sessions/conversations — those are runtime data)
cp "$OPERATOR_DIR"/config.json ".build-data/operators/$SLUG/" 2>/dev/null || true
cp "$OPERATOR_DIR"/context.md ".build-data/operators/$SLUG/" 2>/dev/null || true
cp "$OPERATOR_DIR"/team.json ".build-data/operators/$SLUG/" 2>/dev/null || true

# Create empty runtime dirs
mkdir -p ".build-data/operators/$SLUG/sessions"
mkdir -p ".build-data/operators/$SLUG/conversations"

echo "  Staged: .build-data/operators/$SLUG/"
ls -la ".build-data/operators/$SLUG/"

# Deploy to Fly
fly deploy --app "$APP"

# Clean up
rm -rf .build-data
echo "Done. $APP deployed with $SLUG operator data only."
