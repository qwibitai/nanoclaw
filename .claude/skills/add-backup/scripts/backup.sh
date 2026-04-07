#!/bin/bash
# NanoClaw State Backup Script
# Usage: ./backup.sh [--dry-run] [backup-dir]
#
# Backs up messages.db, groups, sessions, and IPC state.
# Secrets are always excluded. Supports SSH, token, and local-only push.
#
# See: docs/guide-backup-restore.md

set -e

# Parse arguments
DRY_RUN=false
BACKUP_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run|-n)
            DRY_RUN=true
            shift
            ;;
        *)
            BACKUP_DIR="$1"
            shift
            ;;
    esac
done

# Defaults (can be overridden by .env)
BACKUP_DIR="${BACKUP_DIR:-$HOME/backup-nanoclaw}"
NANOCLAW_DIR="${NANOCLAW_DIR:-$HOME/nanoclaw}"
BRANCH="${BRANCH:-main}"
DATE=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$BACKUP_DIR/backup.log"
LOG_MAX_LINES=1000
CHECKSUM_FILE="$BACKUP_DIR/.checksums"

# Rotate log if it exceeds max lines
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt "$LOG_MAX_LINES" ]; then
    tail -n "$LOG_MAX_LINES" "$LOG_FILE" > "$LOG_FILE.tmp"
    mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

# Load environment variables from backup dir
if [ -f "$BACKUP_DIR/.env" ]; then
    source "$BACKUP_DIR/.env"
fi

# Re-apply defaults for values not in .env
BACKUP_DIR="${BACKUP_DIR:-$HOME/backup-nanoclaw}"
NANOCLAW_DIR="${NANOCLAW_DIR:-$HOME/nanoclaw}"
BRANCH="${BRANCH:-main}"

echo "=== NanoClaw Backup ==="
if [ "$DRY_RUN" = true ]; then
    echo "*** DRY RUN - No changes will be made ***"
fi
echo "Source: $NANOCLAW_DIR"
echo "Backup: $BACKUP_DIR"
echo ""

# Initialize backup directory
if [ "$DRY_RUN" = false ]; then
    mkdir -p "$BACKUP_DIR"
    cd "$BACKUP_DIR"
else
    mkdir -p "$BACKUP_DIR"
    cd "$BACKUP_DIR" 2>/dev/null || { echo "Backup dir doesn't exist yet (would create)"; }
fi

# Initialize git if needed
if [ ! -d ".git" ] && [ "$DRY_RUN" = false ]; then
    git init -q
    echo "Initialized git repository in $BACKUP_DIR"
fi

# Create .gitignore only if it doesn't exist (don't overwrite user customizations)
if [ ! -f ".gitignore" ] && [ "$DRY_RUN" = false ]; then
    cat > .gitignore << 'EOF'
# These should never be committed even to backup repo
.env
env
*.keys.json
*recovery*.txt
*password*.txt
.checksums
backup.log
EOF
fi

# Install pre-commit hook to block accidental secret commits
if [ ! -f ".git/hooks/pre-commit" ] && [ "$DRY_RUN" = false ]; then
    mkdir -p .git/hooks
    cat > .git/hooks/pre-commit << 'HOOK'
#!/bin/bash
# Block secret files from being committed
if git diff --cached --name-only | grep -qE '\.env$|\.keys\.json$|recovery.*\.txt$|password.*\.txt$'; then
    echo "BLOCKED: Attempting to commit secret files. Use .gitignore instead."
    exit 1
fi
HOOK
    chmod +x .git/hooks/pre-commit
fi

# Backup functions
backup_dir() {
    local src="$1"
    local dest="$2"
    if [ -d "$src" ]; then
        if [ "$DRY_RUN" = true ]; then
            echo "  [WOULD] $dest ($(du -sh "$src" | cut -f1))"
        else
            mkdir -p "$dest"
            rsync -a --delete "$src/" "$dest/"
            echo "  ✓ $dest"
        fi
    else
        echo "  ⊘ $dest (not found)"
    fi
}

# Exclude sensitive files from groups
backup_groups() {
    local src="$NANOCLAW_DIR/groups"
    local dest="$BACKUP_DIR/groups"

    if [ -d "$src" ]; then
        if [ "$DRY_RUN" = true ]; then
            local size=$(du -sh "$src" | cut -f1)
            echo "  [WOULD] groups/ ($size, excluding sensitive files)"
        else
            mkdir -p "$dest"
            rsync -a --delete \
                --exclude '*.keys.json' \
                --exclude '*recovery*.txt' \
                --exclude '*password*.txt' \
                --exclude '*.env' \
                --exclude '.secrets/' \
                "$src/" "$dest/"
            echo "  ✓ groups/ (excluded secrets & sensitive files)"
        fi
    else
        echo "  ⊘ groups/ (not found)"
    fi
}

echo "Backing up state..."

# Backup store (database) — use sqlite3 backup API for safe concurrent copy
if command -v sqlite3 &>/dev/null && [ -f "$NANOCLAW_DIR/store/messages.db" ]; then
    if [ "$DRY_RUN" = true ]; then
        echo "  [WOULD] store/messages.db (sqlite3 backup)"
    else
        mkdir -p "$BACKUP_DIR/store"
        if sqlite3 "$NANOCLAW_DIR/store/messages.db" ".backup '$BACKUP_DIR/store/messages.db'"; then
            echo "  ✓ store/messages.db (sqlite3 backup)"
        else
            echo "  ✗ store/messages.db (sqlite3 backup failed)"
        fi
    fi
else
    if command -v sqlite3 &>/dev/null; then
        echo "  ⊘ store/messages.db (not found)"
    else
        echo "  ⊘ store/messages.db (sqlite3 not installed — install for safe backups)"
    fi
fi

# Backup groups (exclude sensitive)
backup_groups

# Backup sessions
backup_dir "$NANOCLAW_DIR/data/sessions" "data/sessions"

# Backup IPC state
backup_dir "$NANOCLAW_DIR/data/ipc" "data/ipc"

# Git commit
echo ""
if [ "$DRY_RUN" = true ]; then
    echo "[WOULD] Commit changes to backup repository"
else
    echo "Committing to backup repository..."
    git add -A
    if git diff --cached --quiet; then
        echo "No changes to commit."
    else
        git commit -m "Backup $DATE"
    fi
fi

# Git push
echo ""
REMOTE_URL=$(git -C "$BACKUP_DIR" config --get remote.origin.url 2>/dev/null || true)

if [ "$DRY_RUN" = true ]; then
    if [ -n "$REMOTE_URL" ]; then
        echo "[WOULD] Push to $REMOTE_URL ($BRANCH)"
    else
        echo "[WOULD] No remote configured, skipping push"
    fi
elif [ -z "$REMOTE_URL" ]; then
    echo "Skipping push (no remote configured)"
else
    AUTH_TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"
    if [ -n "$AUTH_TOKEN" ] && [[ "$REMOTE_URL" == https://* ]]; then
        # HTTPS remote with token — inject token into URL
        PUSH_URL=$(echo "$REMOTE_URL" | sed -E 's|https://[^@]+@|https://'"$AUTH_TOKEN"'@|')
        [[ "$PUSH_URL" == "$REMOTE_URL" ]] && PUSH_URL="https://${AUTH_TOKEN}@${REMOTE_URL#https://}"
        echo "Pushing to $REMOTE_URL ($BRANCH)..."
        if git push "$PUSH_URL" "$BRANCH" 2>&1; then
            echo "  ✓ Pushed to remote"
        else
            echo "  ! Push failed. Run manually: cd $BACKUP_DIR && git push origin $BRANCH"
        fi
    else
        # SSH remote or no token needed
        echo "Pushing to $REMOTE_URL ($BRANCH)..."
        if git push "$BRANCH" 2>&1; then
            echo "  ✓ Pushed to remote"
        else
            echo "  ! Push failed. Run manually: cd $BACKUP_DIR && git push origin $BRANCH"
        fi
    fi
fi

# Integrity verification — checksum critical files
echo ""
echo "Verifying backup integrity..."
if [ "$DRY_RUN" = true ]; then
    echo "[WOULD] Generate checksums for backup files"
else
    find "$BACKUP_DIR/store" "$BACKUP_DIR/groups" "$BACKUP_DIR/data" \
        -type f -exec sha256sum {} \; > "$CHECKSUM_FILE"
    CHECKSUM_COUNT=$(wc -l < "$CHECKSUM_FILE")
    echo "  ✓ $CHECKSUM_COUNT files checksummed ($CHECKSUM_FILE)"
fi

echo ""
echo "=== Backup Complete ==="
if [ "$DRY_RUN" = true ]; then
    echo "*** This was a DRY RUN - no changes were made ***"
else
    echo "Total size: $(du -sh "$BACKUP_DIR" | cut -f1)"
fi
echo ""
echo "Remember: Secrets (.env) were NOT backed up."
echo "Store them separately in a secrets manager."
