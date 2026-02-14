#!/bin/bash
# Auto-update script for NanoClaw instances
# Pulls latest code, rebuilds container, and restarts the service

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOCKFILE="/tmp/nanoclaw-update.lock"

echo "🔄 NanoClaw Auto-Update Starting..."
echo "Repository: $REPO_DIR"

# Check if running inside container
if [ -f /.dockerenv ]; then
    echo "⚠️  This script should be run on the host, not inside the container"
    exit 1
fi

# Acquire lock to prevent concurrent updates
exec 200>"$LOCKFILE"
if ! flock -n 200; then
    echo "⚠️  Another update is already running (lock: $LOCKFILE)"
    exit 1
fi
trap 'rm -f "$LOCKFILE"' EXIT

# Navigate to repo directory
cd "$REPO_DIR"

# Check for uncommitted changes and warn user
STASH_CREATED=false
if ! git diff-index --quiet HEAD --; then
    echo ""
    echo "⚠️  WARNING: You have uncommitted changes in your working directory."
    echo "   Auto-update will not proceed with dirty state."
    echo ""
    echo "   Please commit or stash your changes first:"
    echo "     git stash push -m 'Manual stash before update'"
    echo "     # or"
    echo "     git add . && git commit -m 'Your commit message'"
    echo ""
    exit 1
fi

# Get current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "📍 Current branch: $CURRENT_BRANCH"

# Fetch latest changes
echo "⬇️  Fetching latest changes..."
git fetch origin

# Get current and remote commit hashes
LOCAL_COMMIT=$(git rev-parse HEAD)
REMOTE_COMMIT=$(git rev-parse "origin/$CURRENT_BRANCH")

if [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ]; then
    echo "✅ Already up to date (commit: ${LOCAL_COMMIT:0:8})"
    exit 0
fi

echo "🆕 Updates available:"
echo "   Local:  ${LOCAL_COMMIT:0:8}"
echo "   Remote: ${REMOTE_COMMIT:0:8}"

# Pull latest changes
echo "⬇️  Pulling latest code..."
git pull origin "$CURRENT_BRANCH"

# Rebuild container
echo "🔨 Rebuilding container..."
if [ -f "docker-compose.yml" ]; then
    echo "   Using docker-compose..."
    # Support both legacy and new docker compose commands
    if command -v docker-compose &> /dev/null; then
        docker-compose build
    else
        docker compose build
    fi
elif [ -f "container/build.sh" ]; then
    echo "   Using build script..."
    bash container/build.sh
else
    echo "   Using docker build..."
    docker build -t nanoclaw:latest -f container/Dockerfile .
fi

# Restart service
echo "♻️  Restarting service..."
if [ -f "docker-compose.yml" ]; then
    if command -v docker-compose &> /dev/null; then
        docker-compose down
        docker-compose up -d
    else
        docker compose down
        docker compose up -d
    fi
elif command -v systemctl &> /dev/null; then
    # Try systemd service restart
    SERVICE_NAME="${NANOCLAW_SERVICE:-nanoclaw}"
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        echo "   Restarting systemd service: $SERVICE_NAME"
        sudo systemctl restart "$SERVICE_NAME"
    else
        echo "   Service $SERVICE_NAME not found, manual restart required"
    fi
else
    echo "   Manual restart required - no docker-compose or systemd found"
fi

echo "✅ Update complete!"
echo "   New commit: ${REMOTE_COMMIT:0:8}"
