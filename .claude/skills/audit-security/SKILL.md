# Skill: /audit-security

Runs a full security audit of the NanoClaw system. Checks each attack vector,
interprets the results, proposes fixes, and generates a final report at `~/audit-report.md`.

Do not ask for confirmation before running read commands. Do ask for confirmation before
modifying any configuration file.

---

## Pre-flight: Verify required tools

Before starting the audit, check that the required CLI tools are available:

```bash
MISSING=""
for tool in jq sqlite3 curl docker ufw ss; do
  command -v "$tool" &>/dev/null || MISSING="$MISSING $tool"
done

if [ -n "$MISSING" ]; then
  echo "Missing tools:$MISSING"
  echo "Install with: sudo apt-get install -y$MISSING"
else
  echo "All required tools available."
fi
```

If any tools are missing, install them before continuing:

```bash
sudo apt-get install -y <missing-tools>
```

`docker` and `ufw` are typically already present on a NanoClaw VPS. `jq`, `sqlite3`, `curl`, and `ss` (from `iproute2`) are standard Ubuntu packages.

---

## Phase 0: Report setup

Create the report file where findings will be recorded:

```bash
cat > ~/audit-report.md << 'EOF'
# Security Audit Report — NanoClaw
**Date:** $(date +"%Y-%m-%d %H:%M")
**Host:** $(hostname)

## Executive summary
<!-- Filled in at the end -->

## Findings
EOF
```

Define these logging functions for use throughout the audit:

```bash
# Usage: log_ok "message"   log_warn "message"   log_fail "message"
log_ok()   { echo "✅ OK     — $1" | tee -a ~/audit-report.md; }
log_warn() { echo "⚠️  WARN   — $1" | tee -a ~/audit-report.md; }
log_fail() { echo "❌ FAIL   — $1" | tee -a ~/audit-report.md; }
log_info() { echo "ℹ️  INFO   — $1" | tee -a ~/audit-report.md; }
log_section() { echo -e "\n### $1" | tee -a ~/audit-report.md; }
```

---

## Phase 1: System inventory

```bash
log_section "1. System inventory"

node --version
docker --version
uname -r
lsb_release -a 2>/dev/null || cat /etc/os-release

# NanoClaw: detect fork version
cd ~/nanoclaw
git log --oneline -1
```

**Evaluation criteria:**
- Node.js >= 20.x → `log_ok`, otherwise → `log_warn "Node.js outdated: upgrade to 20.x+"`
- Docker >= 24.x → `log_ok`, otherwise → `log_warn "Docker outdated"`
- Ubuntu >= 22.04 → `log_ok`, otherwise → `log_warn "OS outdated"`

---

## Phase 2: Source code — integrity and malware

```bash
log_section "2. Source code audit"
cd ~/nanoclaw
```

### 2.1 Integrity vs upstream

```bash
# Add upstream remote if not present
git remote get-url upstream 2>/dev/null || \
  git remote add upstream https://github.com/qwibitai/nanoclaw.git

git fetch upstream --quiet

# Files in src/ modified relative to upstream
DIFF_FILES=$(git diff upstream/main --name-only -- src/ container/ package.json 2>/dev/null)
```

**Evaluation:**
- If `DIFF_FILES` is empty → `log_ok "src/ identical to upstream"`
- If files exist → `log_warn "Files modified vs upstream:"` and list each with `git diff upstream/main -- <file> --stat`
- Manually inspect the diffs and note whether modifications are expected skills (add-github, add-google-calendar, etc.) or unexpected changes

### 2.2 Malicious code search

```bash
# Unexpected external domains in code
echo "--- Network connections in src/ ---"
UNEXPECTED=$(grep -rn "fetch\|https://" src/ --include="*.ts" 2>/dev/null \
  | grep -v "api.telegram.org\|googleapis.com\|api.github.com\|anthropic\|ollama\|localhost\|127\.0\.0\|172\.17\.")
```

**Evaluation:**
- If `UNEXPECTED` is empty → `log_ok "No unexpected network connections found in code"`
- If results exist → `log_fail "Undocumented external connections found"` and show each line for manual review

```bash
# Exfiltration patterns
echo "--- Searching for hardcoded tokens ---"
HARDCODED=$(grep -rn \
  -e "sk-ant-" \
  -e "ghp_[A-Za-z0-9]" \
  -e "ya29\." \
  src/ --include="*.ts" 2>/dev/null)
```

**Evaluation:**
- If empty → `log_ok "No hardcoded tokens found in code"`
- If results exist → `log_fail "CRITICAL: Hardcoded token found — rotate immediately"` and halt the audit until the user resolves it

### 2.3 npm dependencies

```bash
echo "--- npm audit ---"
npm audit --audit-level=moderate 2>&1
NPM_EXIT=$?
```

**Evaluation:**
- `NPM_EXIT=0` → `log_ok "npm audit found no moderate or higher vulnerabilities"`
- `NPM_EXIT=1` → `log_warn "npm audit found vulnerabilities — review with: npm audit"`
- If critical or high vulnerabilities → `log_fail "Critical/high vulnerabilities in dependencies"`

---

## Phase 3: Telegram — connection mode and allowlist

```bash
log_section "3. Telegram audit"
cd ~/nanoclaw
```

### 3.1 Verify polling vs webhook

```bash
TELEGRAM_TOKEN=$(grep -E "^TELEGRAM" data/env/env 2>/dev/null | head -1 | cut -d= -f2)

if [ -z "$TELEGRAM_TOKEN" ]; then
  log_warn "TELEGRAM_TOKEN not found in data/env/env — is Telegram configured?"
else
  WEBHOOK_INFO=$(curl -s "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo")
  WEBHOOK_URL=$(echo "$WEBHOOK_INFO" | jq -r '.result.url // ""')
fi
```

**Evaluation:**
- If `WEBHOOK_URL` is empty → `log_ok "Telegram in polling mode — no port exposed"`
- If `WEBHOOK_URL` is set → `log_warn "Telegram in webhook mode — URL: $WEBHOOK_URL"` and run additional checks:

```bash
# Only if webhook is active:
# 1. Verify HTTPS port is on localhost, not exposed
ss -tlnp | grep -E ":443|:8443|:80"

# 2. Check for Telegram signature validation in code
VALIDATES_SIG=$(grep -rn "secret_token\|X-Telegram-Bot-Api-Secret-Token\|validateWebhook" \
  src/ --include="*.ts" 2>/dev/null)
if [ -z "$VALIDATES_SIG" ]; then
  log_fail "Active webhook with no signature validation detected in code"
else
  log_ok "Webhook validates Telegram signature"
fi
```

### 3.2 chat_id allowlist in SQLite

```bash
echo "--- Registered groups ---"
sqlite3 store/messages.db "SELECT jid, name, channel, is_main FROM registered_groups;" 2>/dev/null
```

**Evaluation:**
- Show the full table to the user
- `log_info "Manually verify that you recognize all listed JIDs and names"`
- If `is_main=1` for more than one entry → `log_warn "More than one channel marked as main — review"`

---

## Phase 4: Credentials and secrets

```bash
log_section "4. Credentials audit"
cd ~/nanoclaw
```

### 4.1 Secrets in git history

```bash
echo "--- Searching for secrets in git history ---"
GIT_SECRETS=$(git log --all -p 2>/dev/null \
  | grep -E "sk-ant-|ghp_[A-Za-z0-9]{36}|ya29\.|TELEGRAM.*=.*[0-9]{9}" \
  | head -5)
```

**Evaluation:**
- If empty → `log_ok "No secrets found in git history"`
- If results exist → `log_fail "CRITICAL: Secret found in git history — rotate the token and use git-filter-repo to clean the history"`

### 4.2 data/env/env outside git

```bash
TRACKED=$(git ls-files data/env/ 2>/dev/null)
```

**Evaluation:**
- If empty → `log_ok "data/env/env is not tracked by git"`
- If not empty → `log_fail "CRITICAL: data/env/env is in git — run: git rm --cached data/env/env && git commit"`

### 4.3 Permissions on sensitive files

```bash
ENV_PERMS=$(stat -c "%a" data/env/env 2>/dev/null)
DB_PERMS=$(stat -c "%a" store/messages.db 2>/dev/null)
GCP_CREDS_PERMS=$(stat -c "%a" ~/gcp-oauth.keys.json 2>/dev/null)
GCP_TOKENS_PERMS=$(stat -c "%a" ~/.config/google-calendar-mcp/tokens.json 2>/dev/null)
```

**Evaluation and auto-fix (ask for confirmation first):**
- If `ENV_PERMS != 600` → `log_warn "data/env/env has permissions $ENV_PERMS, should be 600"` and ask: "Fix permissions with chmod 600 data/env/env? [y/n]"
- If `DB_PERMS != 600` → same process for store/messages.db
- If both are 600 → `log_ok "Sensitive file permissions correct (600)"`
- If `GCP_CREDS_PERMS` is set and `!= 600` → `log_fail "~/gcp-oauth.keys.json has permissions $GCP_CREDS_PERMS, should be 600 — any process on the system (including Docker containers) can read it"` and offer: `chmod 600 ~/gcp-oauth.keys.json`
- If `GCP_CREDS_PERMS = 600` → `log_ok "~/gcp-oauth.keys.json permissions correct (600)"`
- If `GCP_TOKENS_PERMS` is set and `!= 600` → `log_warn "~/.config/google-calendar-mcp/tokens.json has permissions $GCP_TOKENS_PERMS, should be 600"` and offer: `chmod 600 ~/.config/google-calendar-mcp/tokens.json`
- If `GCP_TOKENS_PERMS = 600` → `log_ok "Google Calendar tokens.json permissions correct (600)"`
- If either GCP file is not present, skip (Google Calendar not installed)

> **Note:** Any file copied with `scp` from Windows must have its permissions verified immediately — Windows does not preserve Unix permissions and files arrive with `0775` by default. Run `ls -la <file>` right after transfer and `chmod 600 <file>` if needed.

### 4.4 .gitignore covers sensitive files

```bash
GITIGNORE_OK=$(grep -E "data/env|\.env|store/" .gitignore 2>/dev/null | wc -l)
```

**Evaluation:**
- If `GITIGNORE_OK >= 2` → `log_ok ".gitignore covers data/env and store/"`
- Otherwise → `log_warn ".gitignore may not cover all sensitive files — review manually"`

---

## Phase 5: Docker containers

```bash
log_section "5. Docker container audit"
```

### 5.1 Running containers

```bash
echo "--- Running containers ---"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>/dev/null
```

### 5.2 Privileges and capabilities

```bash
# For each NanoClaw container
for CID in $(docker ps -q 2>/dev/null); do
  NAME=$(docker inspect $CID --format '{{.Name}}' 2>/dev/null)
  PRIVILEGED=$(docker inspect $CID 2>/dev/null | jq -r '.[].HostConfig.Privileged')
  CAPS=$(docker inspect $CID 2>/dev/null | jq -r '.[].HostConfig.CapAdd | length')
  NET_MODE=$(docker inspect $CID 2>/dev/null | jq -r '.[].HostConfig.NetworkMode')

  echo "Container: $NAME"

  if [ "$PRIVILEGED" = "false" ]; then
    log_ok "$NAME — not privileged"
  else
    log_fail "$NAME — PRIVILEGED=true, isolation compromised"
  fi

  if [ "$CAPS" = "0" ] || [ "$CAPS" = "null" ]; then
    log_ok "$NAME — no additional capabilities"
  else
    log_warn "$NAME — has $CAPS additional capabilities — review"
  fi

  if [ "$NET_MODE" = "host" ]; then
    log_fail "$NAME — NetworkMode=host, no network isolation"
  else
    log_ok "$NAME — isolated network (mode: $NET_MODE)"
  fi
done
```

### 5.3 Container process is not root

```bash
for CID in $(docker ps -q 2>/dev/null); do
  NAME=$(docker inspect $CID --format '{{.Name}}' 2>/dev/null)
  UID_IN_CONTAINER=$(docker exec $CID id -u 2>/dev/null)

  if [ "$UID_IN_CONTAINER" = "0" ]; then
    log_warn "$NAME — process runs as root (uid=0) inside container"
  else
    log_ok "$NAME — process runs as uid=$UID_IN_CONTAINER (non-root)"
  fi
done
```

### 5.4 Mounts — verify which host directories each container exposes

```bash
for CID in $(docker ps -q 2>/dev/null); do
  NAME=$(docker inspect $CID --format '{{.Name}}' 2>/dev/null)
  echo "Mounts for $NAME:"
  docker inspect $CID 2>/dev/null | jq -r '.[].Mounts[] | "\(.Source) → \(.Destination) [\(.Mode)]"'
done
```

**Manual evaluation:** Show the full mount list to the user and ask them to confirm all host paths are expected. Alert if any of these critical paths appear:

```bash
DANGEROUS_MOUNTS=$(docker inspect $(docker ps -q) 2>/dev/null \
  | jq -r '.[].Mounts[].Source' \
  | grep -E "\.ssh|\.gnupg|\.aws|\.config/nanoclaw|/etc/|/root/" 2>/dev/null)

if [ -n "$DANGEROUS_MOUNTS" ]; then
  log_fail "Dangerous mounts detected: $DANGEROUS_MOUNTS"
else
  log_ok "No mounts on sensitive system paths"
fi
```

---

## Phase 6: Hetzner server — network and SSH

```bash
log_section "6. Server audit"
```

### 6.1 Listening ports

```bash
echo "--- Listening ports ---"
ss -tlnp
```

**Evaluation:**
- Show full output to the user
- Look for unexpected ports:

```bash
UNEXPECTED_PORTS=$(ss -tlnp 2>/dev/null \
  | grep -v "127\.0\.0\.1\|::1\|:22 " \
  | grep -E "LISTEN" \
  | grep -v "^State")

if [ -z "$UNEXPECTED_PORTS" ]; then
  log_ok "Only internal or SSH ports exposed"
else
  log_warn "Ports potentially exposed to the internet:"
  echo "$UNEXPECTED_PORTS"
fi
```

### 6.2 UFW firewall

```bash
UFW_STATUS=$(ufw status 2>/dev/null | head -1)
echo "UFW: $UFW_STATUS"

if echo "$UFW_STATUS" | grep -q "active"; then
  log_ok "UFW is active"
  ufw status verbose
else
  log_warn "UFW is not active — only Hetzner Cloud firewall is in effect"
fi
```

### 6.3 SSH hardening

```bash
echo "--- SSH configuration ---"
SSH_PASS=$(grep "^PasswordAuthentication" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')
SSH_ROOT=$(grep "^PermitRootLogin" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')
SSH_PUBKEY=$(grep "^PubkeyAuthentication" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')
```

**Evaluation and auto-fix:**
- `SSH_PASS=no` → `log_ok "PasswordAuthentication disabled"`
- `SSH_PASS=yes` or empty → `log_fail "PasswordAuthentication is enabled — password login possible"` and ask if they want it fixed
- `SSH_ROOT=no` → `log_ok "PermitRootLogin disabled"`
- `SSH_ROOT=yes` or empty → `log_warn "PermitRootLogin not explicitly disabled"`
- `SSH_PUBKEY=yes` → `log_ok "PubkeyAuthentication enabled"`

### 6.4 System users with a shell

```bash
echo "--- Users with an active shell ---"
cat /etc/passwd | grep -v "nologin\|/bin/false" | cut -d: -f1,7
```

**Evaluation:** Show to the user and ask them to confirm all are known. Alert if any unrecognized usernames appear.

### 6.5 Pending security updates

```bash
echo "--- Packages with security updates ---"
apt list --upgradable 2>/dev/null | grep -i security | wc -l
PENDING=$(apt list --upgradable 2>/dev/null | grep -i security | wc -l)
```

**Evaluation:**
- `PENDING=0` → `log_ok "No pending security updates"`
- `PENDING>0` → `log_warn "$PENDING security updates pending"` and ask if they want to run `sudo apt update && sudo apt upgrade -y`

---

## Phase 7: OAuth integrations

```bash
log_section "7. OAuth integrations audit"
cd ~/nanoclaw
```

### 7.1 Google Calendar — token scopes

```bash
TOKEN_FILE=$(find . ~/.config -name "token*.json" 2>/dev/null | grep -i calendar | head -1)

if [ -z "$TOKEN_FILE" ]; then
  log_info "No Google Calendar token found stored locally"
else
  SCOPES=$(cat "$TOKEN_FILE" 2>/dev/null | jq -r '.scope // ""')
  echo "Active Google Calendar scopes: $SCOPES"

  if echo "$SCOPES" | grep -q "calendar.readonly"; then
    log_ok "Google Calendar uses readonly scope"
  elif echo "$SCOPES" | grep -q "calendar"; then
    log_warn "Google Calendar has write scope — is this necessary?"
  fi

  if echo "$SCOPES" | grep -q "https://www.googleapis.com/auth/$" || \
     echo "$SCOPES" | grep -q "https://mail.google.com"; then
    log_fail "Excessively broad Google scope — reduce"
  fi
fi
```

### 7.2 GitHub PAT — type and permissions

```bash
GITHUB_TOKEN=$(grep "^GITHUB_TOKEN" data/env/env 2>/dev/null | cut -d= -f2)

if [ -z "$GITHUB_TOKEN" ]; then
  log_info "GITHUB_TOKEN not found in data/env/env"
else
  # Check token type (fine-grained vs classic)
  if echo "$GITHUB_TOKEN" | grep -q "^github_pat_"; then
    log_ok "GitHub PAT is fine-grained (github_pat_...)"
  elif echo "$GITHUB_TOKEN" | grep -q "^ghp_"; then
    log_warn "GitHub PAT is classic (ghp_...) — migrate to fine-grained PAT for least privilege"
  fi

  # Check scopes (without printing the token)
  SCOPES_HEADER=$(curl -s -I \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    https://api.github.com/rate_limit 2>/dev/null \
    | grep -i "x-oauth-scopes")
  echo "GitHub PAT scopes: $SCOPES_HEADER"

  if echo "$SCOPES_HEADER" | grep -qE "delete_repo|admin|write:org"; then
    log_fail "GitHub PAT has overly broad scopes — reduce to minimum needed"
  else
    log_ok "GitHub PAT scopes appear reasonable — verify manually"
  fi
fi
```

---

## Phase 8: Mount allowlist

```bash
log_section "8. Mount allowlist audit"

ALLOWLIST_FILE="$HOME/.config/nanoclaw/mount-allowlist.json"

if [ ! -f "$ALLOWLIST_FILE" ]; then
  log_warn "mount-allowlist.json not found in ~/.config/nanoclaw/"
else
  echo "--- Current mount allowlist ---"
  cat "$ALLOWLIST_FILE"

  # Look for dangerous paths in the allowlist
  DANGEROUS=$(cat "$ALLOWLIST_FILE" | grep -E "\.ssh|\.gnupg|\.aws|\.config/nanoclaw|/etc/" 2>/dev/null)

  if [ -n "$DANGEROUS" ]; then
    log_fail "Sensitive paths in mount allowlist: $DANGEROUS"
  else
    log_ok "Mount allowlist does not expose sensitive system paths"
  fi

  # Check allowlist file permissions
  ALLOWLIST_PERMS=$(stat -c "%a" "$ALLOWLIST_FILE" 2>/dev/null)
  if [ "$ALLOWLIST_PERMS" = "600" ] || [ "$ALLOWLIST_PERMS" = "644" ]; then
    log_ok "Allowlist permissions: $ALLOWLIST_PERMS"
  else
    log_warn "Allowlist permissions: $ALLOWLIST_PERMS — review"
  fi
fi
```

---

## Phase 9: SQLite database

```bash
log_section "9. SQLite audit"
cd ~/nanoclaw
```

```bash
# Existing tables
echo "--- Tables in messages.db ---"
sqlite3 store/messages.db ".tables" 2>/dev/null

# Registered groups — most critical
echo "--- Registered groups ---"
sqlite3 store/messages.db \
  "SELECT jid, name, channel, is_main FROM registered_groups;" 2>/dev/null

# Number of stored messages
MSG_COUNT=$(sqlite3 store/messages.db "SELECT COUNT(*) FROM messages;" 2>/dev/null)
log_info "$MSG_COUNT messages stored in SQLite (plain text)"

# Active scheduled tasks
echo "--- Active scheduled tasks ---"
sqlite3 store/messages.db \
  "SELECT id, schedule_type, schedule_value, status, next_run FROM scheduled_tasks WHERE status='active';" 2>/dev/null
```

**Evaluation:**
- Show registered groups and ask the user to confirm they recognize all of them
- If `MSG_COUNT > 10000` → `log_warn "High volume of messages stored in plain text — consider purging old messages"`
- Verify permissions: if not 600 → propose fix

---

## Phase 10: Generate final report

```bash
log_section "Executive summary"
```

Count findings by category:

```bash
OK_COUNT=$(grep -c "✅ OK" ~/audit-report.md 2>/dev/null || echo 0)
WARN_COUNT=$(grep -c "⚠️  WARN" ~/audit-report.md 2>/dev/null || echo 0)
FAIL_COUNT=$(grep -c "❌ FAIL" ~/audit-report.md 2>/dev/null || echo 0)

echo "" >> ~/audit-report.md
echo "## Executive summary" >> ~/audit-report.md
echo "| Result | Count |" >> ~/audit-report.md
echo "|---|---|" >> ~/audit-report.md
echo "| ✅ OK | $OK_COUNT |" >> ~/audit-report.md
echo "| ⚠️ WARN | $WARN_COUNT |" >> ~/audit-report.md
echo "| ❌ FAIL | $FAIL_COUNT |" >> ~/audit-report.md
echo "" >> ~/audit-report.md
echo "_Full report saved to ~/audit-report.md_" >> ~/audit-report.md
```

Show the final summary to the user along with the report path:

```bash
echo ""
echo "============================================"
echo "AUDIT COMPLETE"
echo "✅ OK:   $OK_COUNT"
echo "⚠️  WARN: $WARN_COUNT"
echo "❌ FAIL: $FAIL_COUNT"
echo ""
echo "Report saved to: ~/audit-report.md"
echo "============================================"
```

If `FAIL_COUNT > 0`, list all FAILs with their recommended fixes and ask the user which ones they want to apply now.

If `FAIL_COUNT = 0` and `WARN_COUNT = 0`, congratulate the user: the system is in good security shape.

---

## Implementation notes

- **Read-only by default.** All commands in this skill are non-destructive except permission fixes (`chmod`) and package updates (`apt upgrade`), which always require explicit user confirmation.
- **Does not modify source code.** If the audit finds a structural problem (e.g., hardcoded token in code), it reports and stops — it does not attempt to auto-fix it.
- **Requires sqlite3.** If not installed: `sudo apt install -y sqlite3`
- **Requires jq.** If not installed: `sudo apt install -y jq`
- **Soft dependency on hcloud CLI.** If available, can verify Hetzner cloud firewall rules directly. If not, instruct the user to check manually at https://console.hetzner.cloud.
