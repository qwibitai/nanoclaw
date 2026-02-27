#!/bin/bash
set -euo pipefail

# setup-service-user.sh — Create a dedicated low-privilege macOS user
# to run the NanoClaw orchestrator, limiting blast radius from container escapes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [setup-service-user] $*" >> "$LOG_FILE"; }

SVC_USER="nanoclaw-svc"
SVC_UID=599       # Below 500 = hidden from login screen
SVC_HOME="/Users/$SVC_USER"
SVC_PROJECT="$SVC_HOME/nanoclaw"
IMSG_GROUP="nanoclaw-imsg"
IMSG_GID=600
ADMIN_USER="$(whoami)"
ADMIN_HOME="$HOME"
DAEMON_PLIST="/Library/LaunchDaemons/com.nanoclaw.plist"
OLD_AGENT_PLIST="$ADMIN_HOME/Library/LaunchAgents/com.nanoclaw.plist"
NODE_PATH="$(which node)"

log "Starting service user setup: admin=$ADMIN_USER svc=$SVC_USER"

# --- macOS only ---
if [ "$(uname -s)" != "Darwin" ]; then
  cat <<EOF
=== NANOCLAW SETUP: SETUP_SERVICE_USER ===
STATUS: failed
ERROR: macos_only
=== END ===
EOF
  exit 1
fi

# --- Require sudo ---
if ! sudo -n true 2>/dev/null; then
  echo "This script requires sudo. You'll be prompted for your password."
  sudo -v || { echo "sudo auth failed"; exit 1; }
fi

# --- Step 1: Create macOS user ---
if dscl . -read "/Users/$SVC_USER" UniqueID >/dev/null 2>&1; then
  log "User $SVC_USER already exists, skipping creation"
  USER_CREATED="already_exists"
else
  log "Creating user $SVC_USER (UID=$SVC_UID)"
  sudo dscl . -create "/Users/$SVC_USER"
  sudo dscl . -create "/Users/$SVC_USER" UserShell /bin/zsh
  sudo dscl . -create "/Users/$SVC_USER" RealName "NanoClaw Service"
  sudo dscl . -create "/Users/$SVC_USER" UniqueID "$SVC_UID"
  sudo dscl . -create "/Users/$SVC_USER" PrimaryGroupID 20  # staff
  sudo dscl . -create "/Users/$SVC_USER" NFSHomeDirectory "$SVC_HOME"
  sudo createhomedir -c -u "$SVC_USER"
  log "User $SVC_USER created"
  USER_CREATED="true"
fi

# --- Step 2: Clone project ---
GIT_REMOTE="$(cd "$PROJECT_ROOT" && git remote get-url origin 2>/dev/null || echo "")"
if [ -z "$GIT_REMOTE" ]; then
  log "No git remote found, falling back to rsync copy"
  CLONE_METHOD="rsync"
else
  CLONE_METHOD="git"
fi

if [ -d "$SVC_PROJECT/.git" ]; then
  log "Project already exists at $SVC_PROJECT, pulling latest"
  sudo -u "$SVC_USER" bash -c "cd '$SVC_PROJECT' && git pull" >> "$LOG_FILE" 2>&1 || true
  PROJECT_SETUP="updated"
else
  if [ "$CLONE_METHOD" = "git" ]; then
    log "Cloning from $GIT_REMOTE"
    BRANCH="$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")"
    sudo -u "$SVC_USER" git clone --branch "$BRANCH" "$GIT_REMOTE" "$SVC_PROJECT" >> "$LOG_FILE" 2>&1
  else
    log "Copying project via rsync"
    sudo rsync -a --exclude node_modules --exclude .git "$PROJECT_ROOT/" "$SVC_PROJECT/"
  fi
  PROJECT_SETUP="created"
fi

# --- Step 3: Copy secrets and state ---
log "Copying secrets and state to service user project"
sudo mkdir -p "$SVC_PROJECT/store/auth"
sudo mkdir -p "$SVC_PROJECT/groups"
sudo mkdir -p "$SVC_PROJECT/logs"

# .env
if [ -f "$PROJECT_ROOT/.env" ]; then
  sudo cp "$PROJECT_ROOT/.env" "$SVC_PROJECT/.env"
  log "Copied .env"
fi

# WhatsApp auth
if [ -d "$PROJECT_ROOT/store/auth" ] && [ "$(ls -A "$PROJECT_ROOT/store/auth" 2>/dev/null)" ]; then
  sudo cp -R "$PROJECT_ROOT/store/auth/" "$SVC_PROJECT/store/auth/"
  log "Copied WhatsApp auth"
fi

# Messages database
if [ -f "$PROJECT_ROOT/store/messages.db" ]; then
  sudo cp "$PROJECT_ROOT/store/messages.db" "$SVC_PROJECT/store/messages.db"
  log "Copied messages.db"
fi

# Groups (CLAUDE.md files, profiles, etc.)
if [ -d "$PROJECT_ROOT/groups" ] && [ "$(ls -A "$PROJECT_ROOT/groups" 2>/dev/null)" ]; then
  sudo rsync -a "$PROJECT_ROOT/groups/" "$SVC_PROJECT/groups/"
  log "Copied groups directory"
fi

# Set ownership (ignore errors on system-protected dirs like ContainerManager)
sudo chown -R "$SVC_USER:staff" "$SVC_HOME" 2>/dev/null || true
log "Set ownership on $SVC_HOME"

# --- Step 4: Install dependencies ---
log "Installing npm dependencies as $SVC_USER"
sudo -u "$SVC_USER" bash -c "export HOME='$SVC_HOME' && cd '$SVC_PROJECT' && npm install" >> "$LOG_FILE" 2>&1

log "Building TypeScript"
sudo -u "$SVC_USER" bash -c "export HOME='$SVC_HOME' && cd '$SVC_PROJECT' && npm run build" >> "$LOG_FILE" 2>&1

# --- Step 5: Grant iMessage DB access ---
IMSG_ENABLED="false"
if [ -f "$SVC_PROJECT/.env" ]; then
  IMSG_ENV="$(grep '^IMESSAGE_ENABLED=' "$SVC_PROJECT/.env" 2>/dev/null | sed 's/^IMESSAGE_ENABLED=//' || echo "")"
  [ "$IMSG_ENV" = "true" ] && IMSG_ENABLED="true"
fi

IMSG_ACCESS="skipped"
if [ "$IMSG_ENABLED" = "true" ] && [ -f "$ADMIN_HOME/Library/Messages/chat.db" ]; then
  log "Setting up iMessage DB access for $SVC_USER"

  # Create shared group if it doesn't exist
  if ! dscl . -read "/Groups/$IMSG_GROUP" PrimaryGroupID >/dev/null 2>&1; then
    sudo dscl . -create "/Groups/$IMSG_GROUP"
    sudo dscl . -create "/Groups/$IMSG_GROUP" PrimaryGroupID "$IMSG_GID"
    log "Created group $IMSG_GROUP (GID=$IMSG_GID)"
  fi

  # Add service user to group
  sudo dscl . -append "/Groups/$IMSG_GROUP" GroupMembership "$SVC_USER"
  log "Added $SVC_USER to $IMSG_GROUP"

  # Grant group read access to Messages directory and DB
  # This requires Full Disk Access for Terminal — if it fails, provide manual steps
  IMSG_PERM_OK="true"
  if ! sudo chmod 750 "$ADMIN_HOME/Library/Messages" 2>/dev/null; then
    IMSG_PERM_OK="false"
  fi
  if ! sudo chgrp "$IMSG_GROUP" "$ADMIN_HOME/Library/Messages" 2>/dev/null; then
    IMSG_PERM_OK="false"
  fi

  for f in "$ADMIN_HOME/Library/Messages/chat.db" "$ADMIN_HOME/Library/Messages/chat.db-wal" "$ADMIN_HOME/Library/Messages/chat.db-shm"; do
    if [ -f "$f" ]; then
      sudo chmod 640 "$f" 2>/dev/null || IMSG_PERM_OK="false"
      sudo chgrp "$IMSG_GROUP" "$f" 2>/dev/null || IMSG_PERM_OK="false"
    fi
  done

  if [ "$IMSG_PERM_OK" = "true" ]; then
    log "Set permissions on Messages directory"
  else
    log "Could not set Messages permissions (Terminal lacks Full Disk Access)"
    IMSG_ACCESS="needs_fda"
  fi

  # Add IMESSAGE_DB_PATH to service user's .env if not already set
  if ! grep -q '^IMESSAGE_DB_PATH=' "$SVC_PROJECT/.env" 2>/dev/null; then
    echo "IMESSAGE_DB_PATH=$ADMIN_HOME/Library/Messages/chat.db" | sudo tee -a "$SVC_PROJECT/.env" > /dev/null
    log "Added IMESSAGE_DB_PATH to service user .env"
  fi

  IMSG_ACCESS="configured"
fi

# --- Step 6: Create LaunchDaemon ---
log "Creating LaunchDaemon at $DAEMON_PLIST"
sudo tee "$DAEMON_PLIST" > /dev/null <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>UserName</key>
    <string>${SVC_USER}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${SVC_PROJECT}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${SVC_PROJECT}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${SVC_HOME}/.local/bin</string>
        <key>HOME</key>
        <string>${SVC_HOME}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${SVC_PROJECT}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${SVC_PROJECT}/logs/nanoclaw.error.log</string>
</dict>
</plist>
PLISTEOF

log "LaunchDaemon written"

# --- Step 7: Unload old agent, load new daemon ---
AGENT_UNLOADED="false"
if [ -f "$OLD_AGENT_PLIST" ]; then
  if launchctl list 2>/dev/null | grep -q "com.nanoclaw"; then
    launchctl unload "$OLD_AGENT_PLIST" >> "$LOG_FILE" 2>&1 || true
    AGENT_UNLOADED="true"
    log "Unloaded old LaunchAgent"
  fi
fi

DAEMON_LOADED="false"
if sudo launchctl load "$DAEMON_PLIST" >> "$LOG_FILE" 2>&1; then
  DAEMON_LOADED="true"
  log "Loaded LaunchDaemon"
else
  log "Failed to load LaunchDaemon (may already be loaded)"
  # Try bootstrap as fallback
  if sudo launchctl list 2>/dev/null | grep -q "com.nanoclaw"; then
    DAEMON_LOADED="true"
  fi
fi

# --- Step 8: Create update script ---
log "Creating update script"
sudo tee "$SVC_PROJECT/update.sh" > /dev/null <<'UPDATEEOF'
#!/bin/bash
set -euo pipefail
# update.sh — Run as admin to pull latest code and restart the service
# Usage: sudo /Users/nanoclaw-svc/nanoclaw/update.sh

SVC_USER="nanoclaw-svc"
SVC_PROJECT="/Users/nanoclaw-svc/nanoclaw"
DAEMON_PLIST="/Library/LaunchDaemons/com.nanoclaw.plist"

echo "Stopping service..."
sudo launchctl unload "$DAEMON_PLIST" 2>/dev/null || true

echo "Pulling latest code..."
sudo -u "$SVC_USER" bash -c "cd '$SVC_PROJECT' && git pull"

echo "Installing dependencies..."
sudo -u "$SVC_USER" bash -c "cd '$SVC_PROJECT' && npm install"

echo "Building..."
sudo -u "$SVC_USER" bash -c "cd '$SVC_PROJECT' && npm run build"

echo "Starting service..."
sudo launchctl load "$DAEMON_PLIST"

echo "Done. Verify with: sudo launchctl list | grep nanoclaw"
UPDATEEOF

sudo chmod +x "$SVC_PROJECT/update.sh"
sudo chown "$SVC_USER:staff" "$SVC_PROJECT/update.sh"
log "Update script created at $SVC_PROJECT/update.sh"

# --- Step 9: Verify ---
SERVICE_RUNNING="false"
if sudo launchctl list 2>/dev/null | grep -q "com.nanoclaw"; then
  SERVICE_RUNNING="true"
fi

# FDA check — just informational, can't grant programmatically
FDA_NOTE="Ensure node has Full Disk Access (System Settings > Privacy & Security > Full Disk Access)."
if [ "${IMSG_ACCESS:-}" = "needs_fda" ]; then
  FDA_NOTE="REQUIRED: Grant Terminal Full Disk Access, then re-run this script to set iMessage permissions. System Settings > Privacy & Security > Full Disk Access > add Terminal.app"
fi

STATUS="success"
if [ "$DAEMON_LOADED" != "true" ]; then
  STATUS="failed"
fi

log "Setup complete: status=$STATUS daemon_loaded=$DAEMON_LOADED"

cat <<EOF
=== NANOCLAW SETUP: SETUP_SERVICE_USER ===
SVC_USER: $SVC_USER
SVC_HOME: $SVC_HOME
SVC_PROJECT: $SVC_PROJECT
USER_CREATED: $USER_CREATED
PROJECT_SETUP: $PROJECT_SETUP
IMESSAGE_ACCESS: $IMSG_ACCESS
OLD_AGENT_UNLOADED: $AGENT_UNLOADED
DAEMON_PLIST: $DAEMON_PLIST
DAEMON_LOADED: $DAEMON_LOADED
SERVICE_RUNNING: $SERVICE_RUNNING
UPDATE_SCRIPT: $SVC_PROJECT/update.sh
FDA_NOTE: $FDA_NOTE
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

if [ "$STATUS" = "failed" ]; then
  exit 1
fi
