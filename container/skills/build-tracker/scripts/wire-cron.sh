#!/usr/bin/env bash
# wire-cron.sh — Add a build-tracker cron job to ~/.openclaw/cron/jobs.json
# Usage: wire-cron.sh <repo> <discord-channel-id> <cron-expr> [--phases-file path] [--stale-pr-hours N] [--stale-issue-hours N] [--label name]
#
# Example:
#   wire-cron.sh stevengonsalvez/qstatus 1486878696827650058 "0 */4 * * *"
#   wire-cron.sh stevengonsalvez/biolift 1482830828898615459 "0 */2 * * *" --label "biolift.build-tracker"

set -euo pipefail

REPO="${1:-}"
CHANNEL_ID="${2:-}"
CRON_EXPR="${3:-}"
PHASES_FILE=""
STALE_PR_H=4
STALE_ISSUE_H=8
LABEL=""

shift 3 || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phases-file) PHASES_FILE="$2"; shift 2 ;;
    --stale-pr-hours) STALE_PR_H="$2"; shift 2 ;;
    --stale-issue-hours) STALE_ISSUE_H="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$REPO" || -z "$CHANNEL_ID" || -z "$CRON_EXPR" ]]; then
  echo "Usage: wire-cron.sh <repo> <discord-channel-id> <cron-expr> [options]" >&2
  exit 2
fi

REPO_SLUG="${REPO//\//-}"
[[ -z "$LABEL" ]] && LABEL="popashot/${REPO_SLUG}.build-tracker"
SKILL_SCRIPT="$(dirname "$0")/run-tracker.sh"
CRON_FILE="$HOME/.openclaw/cron/jobs.json"

# Backup
BACKUP="/tmp/openclaw-cron-backup-$(date +%s).json"
cp "$CRON_FILE" "$BACKUP"
echo "Backed up to $BACKUP"

# Build the tracker script invocation
TRACKER_CMD="bash '${SKILL_SCRIPT}' '${REPO}'"
[[ -n "$PHASES_FILE" ]] && TRACKER_CMD="PHASES_FILE='${PHASES_FILE}' ${TRACKER_CMD}"

# Build message for cron payload
# The cron agent runs the script, reads the output, and posts only if TRACKER_ALERT
PHASES_FILE_JSON="${PHASES_FILE}"
STALE_PR_H_JSON="${STALE_PR_H}"
STALE_ISSUE_H_JSON="${STALE_ISSUE_H}"

MESSAGE=$(cat <<MSGEOF
🎯 Build Tracker: ${REPO}

Run the tracker script:
\`\`\`bash
STALE_PR_HOURS=${STALE_PR_H} STALE_ISSUE_HOURS=${STALE_ISSUE_H}${PHASES_FILE:+ PHASES_FILE='${PHASES_FILE}'} bash ~/d/popashot-agent/skills/build-tracker/scripts/run-tracker.sh '${REPO}'
\`\`\`

If output starts with TRACKER_OK: reply HEARTBEAT_OK, stay silent.
If output starts with TRACKER_ALERT: post the findings to Discord channel ${CHANNEL_ID} in a clear summary. Mention the relevant agents based on PR author / issue assignee. Keep it short — one message.

Do not call any LLMs or spawn agents. This is a pure script check.
MSGEOF
)

# Inject job + validate before writing
python3 - <<PYEOF
import json, uuid, time

with open('$CRON_FILE', 'r') as f:
    data = json.load(f)

new_job = {
    'id': str(uuid.uuid4()),
    'agentId': 'popashot',
    'name': '${LABEL}',
    'enabled': True,
    'createdAtMs': int(time.time() * 1000),
    'updatedAtMs': int(time.time() * 1000),
    'schedule': {
        'kind': 'cron',
        'expr': '${CRON_EXPR}',
        'tz': 'Europe/London',
        'staggerMs': 300000
    },
    'sessionTarget': 'isolated',
    'wakeMode': 'next-heartbeat',
    'payload': {
        'kind': 'agentTurn',
        'model': 'sonnet',
        'message': '''${MESSAGE}'''
    },
    'delivery': {
        'mode': 'announce',
        'channel': 'discord',
        'to': '${CHANNEL_ID}',
        'bestEffort': True
    }
}

data['jobs'].append(new_job)

with open('$CRON_FILE', 'w') as f:
    json.dump(data, f, indent=2)

print(f"Added job: {new_job['name']} ({new_job['id']})")
print(f"Schedule: {new_job['schedule']}")
PYEOF

echo "✅ Cron wired. Next ${CRON_EXPR} fire will run build tracker for ${REPO}"
