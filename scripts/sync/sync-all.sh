#!/bin/bash
# Master sync script: email + calendar + SimpleMem ingest
# Runs every 8 hours via launchd
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/sync.log"
PYTHON3="/usr/bin/python3"

# Redirect all output to log (and stdout for launchd)
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "=========================================="
echo "SYNC RUN: $(date)"
echo "=========================================="

# Ensure pip packages are available
export PATH="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

ERRORS=0

# --- Step 1: Exchange email → mikejg1838@gmail.com ---
echo ""
echo "[1/4] Exchange email sync..."
MARVIN_DIR="/Users/mgandal/Agents/marvin2"
if [ -f "$MARVIN_DIR/scripts/email-migrate.py" ]; then
    OUTPUT=$($PYTHON3 "$MARVIN_DIR/scripts/email-migrate.py" 2>&1)
    EC=$?
    echo "$OUTPUT" | tail -20
    if [ $EC -ne 0 ]; then
        echo "[1/4] WARNING: Exchange email sync had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[1/4] SKIP: email-migrate.py not found at $MARVIN_DIR/scripts/"
fi

# --- Step 2: Gmail sync (mgandal → mikejg1838) ---
echo ""
echo "[2/4] Gmail sync: mgandal@gmail.com → mikejg1838@gmail.com..."
$PYTHON3 "$SCRIPT_DIR/gmail-sync.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[2/4] WARNING: Gmail sync had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 3: Calendar sync (Outlook → MJG-outlook + MJG-sync) ---
echo ""
echo "[3/4] Calendar sync..."
bash "$SCRIPT_DIR/calendar-sync.sh" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[3/4] WARNING: Calendar sync had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 4: SimpleMem email ingest ---
echo ""
echo "[4/4] SimpleMem email ingest..."
$PYTHON3 "$SCRIPT_DIR/simplemem-ingest.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[4/4] WARNING: SimpleMem ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

echo ""
echo "=========================================="
echo "SYNC COMPLETE: $(date) (errors: $ERRORS)"
echo "=========================================="

# Trim log file if over 1MB
if [ -f "$LOG_FILE" ]; then
    SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null)
    if [ "$SIZE" -gt 1048576 ] 2>/dev/null; then
        tail -5000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
    fi
fi

exit $ERRORS
