---
name: add-almanda-core
description: Install the Almanda persona — renames the assistant from Andy to Almanda, adds global operating rules (read-freely / ask-before-writes / suggest-for-judgment), scaffolds the capability index in groups/global/CLAUDE.md, fixes the main-group systemPrompt gap, and installs the almanda-ops container skill.
---

# Add Almanda Core

Installs the Almanda persona layer as the base identity for all groups.

## What This Adds

- Renames the assistant from "Andy" to "Almanda" across all group CLAUDE.md files
- Adds global operating rules: read/retrieve immediately; ask before writes; suggest judgment-heavy searches
- Adds a capability index table (updated by later skills like `/add-company-kb`, `/add-linear-ops`)
- Fixes the main-group systemPrompt gap so `groups/global/CLAUDE.md` is loaded for the main group too
- Installs `container/skills/almanda-ops/SKILL.md` as the on-demand write-approval playbook

## Prerequisites

- NanoClaw v1 fully set up (`/setup` complete)
- Identity layer installed (`/add-identity`)
- Policy layer installed (`/add-policy`)

## Installation Steps

Run all steps automatically. Only pause when explicitly marked.

### 1. Merge the skill branch

```bash
git merge skill/add-almanda-core --no-edit
```

If there are merge conflicts in `container/agent-runner/src/index.ts`, resolve manually:
- The only change is removing `!containerInput.isMain && ` from the `if` condition at line ~418.
- Before: `if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {`
- After:  `if (fs.existsSync(globalClaudeMdPath)) {`

### 2. Rename Andy → Almanda in runtime group CLAUDE.md files

The branch renames `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md` (tracked in git).
Runtime-created groups (Slack, Telegram, etc.) need renaming on the host:

```bash
for f in groups/*/CLAUDE.md; do
  if grep -q "You are Andy" "$f"; then
    sed -i.bak \
      -e 's/^# Andy$/# Almanda/' \
      -e 's/^You are Andy, a personal assistant\./You are Almanda, the company AI assistant at Alma Labs./' \
      "$f"
    rm -f "${f}.bak"
    echo "Updated: $f"
  fi
done
```

Verify:
```bash
grep -rn "You are Andy" groups/ && echo "FAIL: Andy still present" || echo "OK: All renamed"
```

### 3. Rebuild and restart

```bash
# Rebuild container
./container/build.sh

# Rebuild main app
npm run build

# Invalidate per-group agent-runner cache
rm -rf data/sessions/*/agent-runner-src/

# Restart service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# Linux: systemctl --user restart nanoclaw
```

Wait 5 seconds, then verify:
```bash
launchctl list | grep nanoclaw  # macOS
# Linux: systemctl --user status nanoclaw
```

### 4. Verify

Send a message in the main group:
> "What's your name?"

Expected: response contains "Almanda" — NOT "Andy".

Send a write-action probe:
> "Create a task in Linear for this."

Expected: Almanda describes the action and asks "Should I go ahead?" — does NOT create anything without approval.

## Troubleshooting

**Container still shows "Andy":**
- Clear per-group cache: `rm -rf data/sessions/*/agent-runner-src/`
- Confirm `groups/global/CLAUDE.md` starts with `# Almanda`
- Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

**Operating rules not in context:**
- Check container logs: `cat groups/main/logs/container-*.log | tail -30`
- If global CLAUDE.md content is absent, confirm the `!containerInput.isMain` guard was removed in `container/agent-runner/src/index.ts`
- Rebuild: `./container/build.sh && npm run build`
