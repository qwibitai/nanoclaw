#!/bin/bash
set -euo pipefail

# 04-auth-whatsapp.sh — Full WhatsApp auth flow with polling

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [auth-whatsapp] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

# Parse args
METHOD=""
PHONE=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --method) METHOD="$2"; shift 2 ;;
    --phone)  PHONE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$METHOD" ]; then
  log "ERROR: --method flag is required"
  cat <<EOF
=== NANOCLAW SETUP: AUTH_WHATSAPP ===
AUTH_METHOD: unknown
AUTH_STATUS: failed
STATUS: failed
ERROR: missing_method_flag
LOG: logs/setup.log
=== END ===
EOF
  exit 4
fi

# Background process PID for cleanup
AUTH_PID=""
cleanup() {
  if [ -n "$AUTH_PID" ] && kill -0 "$AUTH_PID" 2>/dev/null; then
    log "Cleaning up auth process (PID $AUTH_PID)"
    kill "$AUTH_PID" 2>/dev/null || true
    wait "$AUTH_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Helper: poll a file for a pattern
# Usage: poll_file FILE PATTERN TIMEOUT_SECS INTERVAL_SECS
poll_file() {
  local file="$1" pattern="$2" timeout="$3" interval="$4"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if [ -f "$file" ]; then
      local content
      content=$(cat "$file" 2>/dev/null || echo "")
      if echo "$content" | grep -qE "$pattern"; then
        echo "$content"
        return 0
      fi
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  return 1
}

# Helper: get phone number from auth creds if available
get_phone_number() {
  if [ -f "$PROJECT_ROOT/store/auth/creds.json" ]; then
    node -e "
      const c = require('./store/auth/creds.json');
      if (c.me && c.me.id) {
        const phone = c.me.id.split(':')[0].split('@')[0];
        process.stdout.write(phone);
      }
    " 2>/dev/null || true
  fi
}

clean_stale_state() {
  log "Cleaning stale auth state"
  rm -rf "$PROJECT_ROOT/store/auth" "$PROJECT_ROOT/store/qr-data.txt" "$PROJECT_ROOT/store/auth-status.txt"
}

emit_status() {
  local auth_status="$1" status="$2" error="${3:-}" pairing_code="${4:-}"
  local phone_number
  phone_number=$(get_phone_number)

  cat <<EOF
=== NANOCLAW SETUP: AUTH_WHATSAPP ===
AUTH_METHOD: $METHOD
AUTH_STATUS: $auth_status
EOF
  [ -n "$pairing_code" ] && echo "PAIRING_CODE: $pairing_code"
  [ -n "$phone_number" ] && echo "PHONE_NUMBER: $phone_number"
  echo "STATUS: $status"
  [ -n "$error" ] && echo "ERROR: $error"
  cat <<EOF
LOG: logs/setup.log
=== END ===
EOF
}

case "$METHOD" in

  qr-browser)
    log "Starting QR browser auth flow"
    clean_stale_state

    # Start auth in background
    npm run auth >> "$LOG_FILE" 2>&1 &
    AUTH_PID=$!
    log "Auth process started (PID $AUTH_PID)"

    # Poll for QR data or already_authenticated
    log "Polling for QR data (15s timeout)"
    QR_READY="false"
    for i in $(seq 1 15); do
      if [ -f "$PROJECT_ROOT/store/auth-status.txt" ]; then
        STATUS_CONTENT=$(cat "$PROJECT_ROOT/store/auth-status.txt" 2>/dev/null || echo "")
        if [ "$STATUS_CONTENT" = "already_authenticated" ]; then
          log "Already authenticated"
          emit_status "already_authenticated" "success"
          exit 0
        fi
      fi
      if [ -f "$PROJECT_ROOT/store/qr-data.txt" ]; then
        QR_READY="true"
        break
      fi
      # Check if auth process died early
      if ! kill -0 "$AUTH_PID" 2>/dev/null; then
        log "Auth process exited prematurely"
        emit_status "failed" "failed" "auth_process_crashed"
        exit 1
      fi
      sleep 1
    done

    if [ "$QR_READY" = "false" ]; then
      log "Timeout waiting for QR data"
      emit_status "failed" "failed" "qr_timeout"
      exit 3
    fi

    # Generate QR SVG and inject into HTML template
    log "Generating QR SVG"
    node -e "
      const QR = require('qrcode');
      const fs = require('fs');
      const qrData = fs.readFileSync('store/qr-data.txt', 'utf8');
      QR.toString(qrData, { type: 'svg' }, (err, svg) => {
        if (err) process.exit(1);
        const template = fs.readFileSync('.claude/skills/setup/scripts/qr-auth.html', 'utf8');
        fs.writeFileSync('store/qr-auth.html', template.replace('{{QR_SVG}}', svg));
      });
    " >> "$LOG_FILE" 2>&1

    # Open in browser (macOS)
    if command -v open >/dev/null 2>&1; then
      open "$PROJECT_ROOT/store/qr-auth.html"
      log "Opened QR auth page in browser"
    else
      log "WARNING: 'open' command not found, cannot open browser"
    fi

    # Poll for completion (120s, 2s intervals)
    log "Polling for auth completion (120s timeout)"
    for i in $(seq 1 60); do
      if [ -f "$PROJECT_ROOT/store/auth-status.txt" ]; then
        STATUS_CONTENT=$(cat "$PROJECT_ROOT/store/auth-status.txt" 2>/dev/null || echo "")
        case "$STATUS_CONTENT" in
          authenticated|already_authenticated)
            log "Authentication successful: $STATUS_CONTENT"
            # Replace QR page with success page so browser auto-refresh shows it
            cat > "$PROJECT_ROOT/store/qr-auth.html" <<'SUCCESSEOF'
<!DOCTYPE html>
<html><head><title>NanoClaw - Connected!</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  h2 { color: #27ae60; margin: 0 0 8px; }
  p { color: #666; }
  .check { font-size: 64px; margin-bottom: 16px; }
</style></head><body>
<div class="card">
  <div class="check">&#10003;</div>
  <h2>Connected to WhatsApp</h2>
  <p>You can close this tab.</p>
</div>
<script>localStorage.removeItem('nanoclaw_qr_start');</script>
</body></html>
SUCCESSEOF
            emit_status "$STATUS_CONTENT" "success"
            exit 0
            ;;
          failed:logged_out)
            log "Auth failed: logged out"
            emit_status "failed" "failed" "logged_out"
            exit 1
            ;;
          failed:qr_timeout)
            log "Auth failed: QR timeout"
            emit_status "failed" "failed" "qr_timeout"
            exit 1
            ;;
          failed:515)
            log "Auth failed: 515 stream error"
            emit_status "failed" "failed" "515"
            exit 1
            ;;
          failed:*)
            log "Auth failed: $STATUS_CONTENT"
            emit_status "failed" "failed" "${STATUS_CONTENT#failed:}"
            exit 1
            ;;
        esac
      fi
      sleep 2
    done

    log "Timeout waiting for auth completion"
    emit_status "failed" "failed" "timeout"
    exit 3
    ;;

  pairing-code)
    if [ -z "$PHONE" ]; then
      log "ERROR: --phone is required for pairing-code method"
      cat <<EOF
=== NANOCLAW SETUP: AUTH_WHATSAPP ===
AUTH_METHOD: pairing-code
AUTH_STATUS: failed
STATUS: failed
ERROR: missing_phone_number
LOG: logs/setup.log
=== END ===
EOF
      exit 4
    fi

    log "Starting pairing code auth flow (phone: $PHONE)"
    clean_stale_state

    # Start auth with pairing code in background
    npx tsx src/whatsapp-auth.ts --pairing-code --phone "$PHONE" >> "$LOG_FILE" 2>&1 &
    AUTH_PID=$!
    log "Auth process started (PID $AUTH_PID)"

    # Poll for pairing code or already_authenticated
    log "Polling for pairing code (15s timeout)"
    PAIRING_CODE=""
    for i in $(seq 1 15); do
      if [ -f "$PROJECT_ROOT/store/auth-status.txt" ]; then
        STATUS_CONTENT=$(cat "$PROJECT_ROOT/store/auth-status.txt" 2>/dev/null || echo "")
        case "$STATUS_CONTENT" in
          already_authenticated)
            log "Already authenticated"
            emit_status "already_authenticated" "success"
            exit 0
            ;;
          pairing_code:*)
            PAIRING_CODE="${STATUS_CONTENT#pairing_code:}"
            log "Got pairing code: $PAIRING_CODE"
            break
            ;;
          failed:*)
            log "Auth failed early: $STATUS_CONTENT"
            emit_status "failed" "failed" "${STATUS_CONTENT#failed:}"
            exit 1
            ;;
        esac
      fi
      sleep 1
    done

    if [ -z "$PAIRING_CODE" ]; then
      log "Timeout waiting for pairing code"
      emit_status "failed" "failed" "pairing_code_timeout"
      exit 3
    fi

    # Poll for completion (120s, 2s intervals)
    log "Polling for auth completion (120s timeout)"
    for i in $(seq 1 60); do
      if [ -f "$PROJECT_ROOT/store/auth-status.txt" ]; then
        STATUS_CONTENT=$(cat "$PROJECT_ROOT/store/auth-status.txt" 2>/dev/null || echo "")
        case "$STATUS_CONTENT" in
          authenticated|already_authenticated)
            log "Authentication successful: $STATUS_CONTENT"
            emit_status "$STATUS_CONTENT" "success" "" "$PAIRING_CODE"
            exit 0
            ;;
          failed:logged_out)
            log "Auth failed: logged out"
            emit_status "failed" "failed" "logged_out" "$PAIRING_CODE"
            exit 1
            ;;
          failed:*)
            log "Auth failed: $STATUS_CONTENT"
            emit_status "failed" "failed" "${STATUS_CONTENT#failed:}" "$PAIRING_CODE"
            exit 1
            ;;
        esac
      fi
      sleep 2
    done

    log "Timeout waiting for auth completion"
    emit_status "failed" "failed" "timeout" "$PAIRING_CODE"
    exit 3
    ;;

  qr-terminal)
    log "QR terminal method selected — manual flow"
    cat <<EOF
=== NANOCLAW SETUP: AUTH_WHATSAPP ===
AUTH_METHOD: qr-terminal
AUTH_STATUS: manual
PROJECT_PATH: $PROJECT_ROOT
STATUS: manual
LOG: logs/setup.log
=== END ===
EOF
    exit 0
    ;;

  *)
    log "Unknown auth method: $METHOD"
    cat <<EOF
=== NANOCLAW SETUP: AUTH_WHATSAPP ===
AUTH_METHOD: $METHOD
AUTH_STATUS: failed
STATUS: failed
ERROR: unknown_method
LOG: logs/setup.log
=== END ===
EOF
    exit 4
    ;;
esac
