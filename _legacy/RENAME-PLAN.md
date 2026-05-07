# Plan: rename `~/nanoclaw-merge` → `~/nanoclaw`

Drafted 2026-05-07 as a controlled-session prerequisite. This is a
plan, not an instruction to execute. Walk through each section with
the operator before any destructive moves.

## Goal

Rename the running 2.0 checkout from `~/nanoclaw-merge` to `~/nanoclaw`
(the canonical name) without breaking the running daemon or any
auxiliary launchd-managed services. Archive the 1.2.49 tree at
`~/nanoclaw-1.x` so it remains intact for rollback or for the few
services that genuinely need 1.x state (e.g. iblai-router).

## Pre-flight inventory

### Plists referencing one path or the other

| Plist | Refs `~/nanoclaw` | Refs `~/nanoclaw-merge` | Disposition |
|---|---|---|---|
| `com.jibot.nanoclaw.plist` | — | TMPDIR + ProgramArguments + WorkingDirectory | **Repoint to `~/nanoclaw/`** (the renamed merge tree) |
| `com.jibot.nanoclaw.plist.bak-pre-2.0` | yes | — | leave as-is (rollback artifact) |
| `com.jibot.access-audit.plist` | ProgramArguments + WorkingDirectory | — | **Disable** (script depends on 1.x-only `send-message.py`) |
| `com.jibot.ipc-lifecycle.plist` | ProgramArguments + 2× log paths | — | **Disable** (1.x IPC pattern, no v2 equivalent) |
| `com.jibot.qmd-fleet.plist` | ProgramArguments | — | **Repoint to `~/nanoclaw/scripts/qmd-fleet.py`** (identical script in merge) |
| `com.jibot.tcp-mcp-bridge.plist` | ProgramArguments | — | **Repoint to `~/nanoclaw/scripts/tcp-mcp-bridge.cjs`** (identical script in merge) |
| `com.nanoclaw.iblai-router.plist` | ProgramArguments + WorkingDirectory + start.sh + config.json | — | **Repoint to `~/nanoclaw-1.x/`** (router/ only exists in 1.x) |
| `com.jibot.signal-cli.plist`, watchdog, reap-zombies, etc. | none for nanoclaw paths | — | no change |

### Internal hardcoded paths inside scripts

| Script | What it reads from `$HOME/nanoclaw/...` | After rename, will hit | Implication |
|---|---|---|---|
| `audit-access.mjs` | `audit/`, `.env`, `scripts/send-message.py` | renamed merge tree (no `audit/`, `.env` exists, no `send-message.py`) | will fail — disable plist |
| `ipc-lifecycle.sh` | `data/ipc/`, `logs/` | renamed merge tree (no `ipc/`) | silent no-op; safe to disable |
| `qmd-fleet.py` | `~/.config/qmd/fleet.yaml` | (no nanoclaw refs internally) | works either way |
| `tcp-mcp-bridge.cjs` | `/opt/homebrew/bin/qmd` | (no nanoclaw refs internally) | works either way |
| `router/start.sh` | `~/nanoclaw/.env` for ANTHROPIC_API_KEY | If pointed at `~/nanoclaw-1.x/` → the 1.x .env (presumably still has the key) | **Verify the 1.x .env still has ANTHROPIC_API_KEY** |

### Git checkout

- Git remote on `~/nanoclaw-merge`: `Joi/nanoclaw.git` (canonical). Rename of local dir doesn't touch git.
- Working tree clean post-push.
- One thing to double-check before move: `git status` shows nothing uncommitted (otherwise the rename loses local work).

### Backups already on disk (verify each before proceeding)

- `~/nanoclaw-prod-data-20260506-1249.tgz` (1.x data tar, 381 MB)
- `~/nanoclaw-prod-env-backup-20260506.bak` (1.x env)
- `~/Library/LaunchAgents/com.jibot.nanoclaw.plist.bak-pre-2.0`
- `~/Library/LaunchAgents/com.jibot.signal-cli.plist.bak-pre-tcp`

## Execution plan

### Stage A — dry checks (zero risk)

1. Confirm git tree clean and pushed:
   ```bash
   cd ~/nanoclaw-merge
   git status      # expect nothing
   git log origin/main..HEAD --oneline   # expect nothing
   ```

2. Confirm backups exist:
   ```bash
   ls -lh ~/nanoclaw-prod-data-20260506-1249.tgz \
          ~/nanoclaw-prod-env-backup-20260506.bak \
          ~/Library/LaunchAgents/com.jibot.nanoclaw.plist.bak-pre-2.0 \
          ~/Library/LaunchAgents/com.jibot.signal-cli.plist.bak-pre-tcp
   ```

3. Verify ANTHROPIC_API_KEY present in 1.x .env (for iblai-router after
   it's repointed at `~/nanoclaw-1.x/`):
   ```bash
   grep -c '^ANTHROPIC_API_KEY=' ~/nanoclaw/.env       # expect: 1
   ```

4. Take a fresh `.bak-pre-rename` snapshot of every plist we're about
   to edit:
   ```bash
   for p in com.jibot.nanoclaw com.jibot.access-audit com.jibot.ipc-lifecycle \
            com.jibot.qmd-fleet com.jibot.tcp-mcp-bridge com.nanoclaw.iblai-router; do
     cp ~/Library/LaunchAgents/$p.plist ~/Library/LaunchAgents/$p.plist.bak-pre-rename
   done
   ```

### Stage B — stop services (downtime begins)

Estimated downtime: **30–90 seconds**, all in this stage.

1. Main daemon:
   ```bash
   launchctl bootout gui/$(id -u)/com.jibot.nanoclaw
   until ! pgrep -f nanoclaw-merge/dist/index.js >/dev/null; do sleep 1; done
   ```

2. Auxiliary services that touch the trees we're about to move
   (everything else, like signal-cli, can stay running):
   ```bash
   launchctl bootout gui/$(id -u)/com.jibot.access-audit       || true
   launchctl bootout gui/$(id -u)/com.jibot.ipc-lifecycle      || true
   launchctl bootout gui/$(id -u)/com.jibot.qmd-fleet
   launchctl bootout gui/$(id -u)/com.jibot.tcp-mcp-bridge
   launchctl bootout gui/$(id -u)/com.nanoclaw.iblai-router
   ```

3. Stop any container in flight (avoid mounts pointing at a path
   we're about to rename):
   ```bash
   docker ps --format '{{.Names}}' | grep '^nanoclaw-v2-' | xargs -r docker rm -f
   ```

### Stage C — move trees

1. Archive the 1.x tree:
   ```bash
   mv ~/nanoclaw ~/nanoclaw-1.x
   ```

2. Promote the merge tree to canonical:
   ```bash
   mv ~/nanoclaw-merge ~/nanoclaw
   ```

3. Verify:
   ```bash
   ls -ld ~/nanoclaw ~/nanoclaw-1.x   # both exist, nanoclaw-merge gone
   cat ~/nanoclaw/package.json | grep version   # expect "2.0.33"
   cat ~/nanoclaw-1.x/package.json | grep version   # expect "1.2.49"
   ```

### Stage D — update plists

Use `sed -i ''` with explicit before/after pairs. One sed per plist —
verify each before moving on.

#### D1. `com.jibot.nanoclaw.plist` — repoint to renamed merge tree

```bash
sed -i '' 's|/Users/jibot/nanoclaw-merge|/Users/jibot/nanoclaw|g' \
   ~/Library/LaunchAgents/com.jibot.nanoclaw.plist
grep -nE '/Users/jibot/nanoclaw' ~/Library/LaunchAgents/com.jibot.nanoclaw.plist
# expect three lines, no `-merge` suffix
```

#### D2. `com.nanoclaw.iblai-router.plist` — repoint to 1.x archive

```bash
sed -i '' 's|/Users/jibot/nanoclaw/|/Users/jibot/nanoclaw-1.x/|g' \
   ~/Library/LaunchAgents/com.nanoclaw.iblai-router.plist
grep -nE '/Users/jibot/nanoclaw' ~/Library/LaunchAgents/com.nanoclaw.iblai-router.plist
```

#### D3. `com.jibot.qmd-fleet.plist`, `com.jibot.tcp-mcp-bridge.plist` — repoint to renamed merge

```bash
sed -i '' 's|/Users/jibot/nanoclaw/scripts/|/Users/jibot/nanoclaw/scripts/|g' \
   ~/Library/LaunchAgents/com.jibot.qmd-fleet.plist \
   ~/Library/LaunchAgents/com.jibot.tcp-mcp-bridge.plist
# (no-op since the path stays the same — but re-grep to confirm)
```

(Note: these two plists already say `/Users/jibot/nanoclaw/scripts/...`
which after the rename now points at the new merge-renamed-to-nanoclaw
tree. No edit needed; but explicitly re-grep to confirm before proceeding.)

#### D4. `com.jibot.access-audit.plist` and `com.jibot.ipc-lifecycle.plist` — disable

These are 1.x-only. Move them out of LaunchAgents (don't delete):

```bash
mkdir -p ~/Library/LaunchAgents/disabled-pre-rename
mv ~/Library/LaunchAgents/com.jibot.access-audit.plist \
   ~/Library/LaunchAgents/disabled-pre-rename/
mv ~/Library/LaunchAgents/com.jibot.ipc-lifecycle.plist \
   ~/Library/LaunchAgents/disabled-pre-rename/
```

(They were already booted out in Stage B; this prevents auto-load
on next reboot.)

### Stage E — restart services

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jibot.nanoclaw.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jibot.qmd-fleet.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jibot.tcp-mcp-bridge.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.iblai-router.plist
```

### Stage F — smoke test

1. Main daemon up:
   ```bash
   launchctl list | grep com.jibot.nanoclaw
   tail -50 /tmp/nanoclaw.stdout.log | grep -E 'Channel adapter started|NanoClaw running'
   ```
   Expect: at least the email + signal + telegram + slack channels
   reporting started.

2. Email channel routing intact (drop a fresh `#cal` or `#ws:` test):
   - Watch for `Email pre-router routed thread` in the log within 30s
   - Confirm the intake file appears in
     `~/nanoclaw/data/email-state-jibot_at_ito_com.json` (the renamed
     state path)
   - Confirm syncthing → macazbd is still flowing (sidecar share
     still under `~/switchboard/ops/jibot/`, untouched by the rename)

3. iblai-router up:
   ```bash
   launchctl list | grep iblai-router
   ```

4. QMD MCP bridge up:
   ```bash
   nc -zv 127.0.0.1 7333   # qmd-public
   nc -zv 127.0.0.1 7334   # tcp-mcp-bridge default index
   ```

### Stage G — durable cleanup

Optional, after a few days of stability:

1. Update `_legacy/POST-CUTOVER-MIGRATION.md` to reflect that the tree
   was renamed (the doc currently references `~/nanoclaw-merge` in a
   few places).

2. If you don't expect to need 1.x rollback any more, you can `tar`
   `~/nanoclaw-1.x` and remove the live tree — but don't delete the
   tar. The router/ subdir of 1.x is the only thing the iblai-router
   actually needs at runtime, so a leaner shape is `~/nanoclaw-1.x-router-only/`.

3. Update any personal scripts / aliases / IDE workspaces that have
   `~/nanoclaw-merge` baked in. Claude Code conversation history
   (`~/.claude/projects/-Users-jibot-nanoclaw-merge/`) won't follow
   the rename — start a fresh session in `~/nanoclaw`. Old transcripts
   are still readable via `claude --resume` but live under the old
   project key.

## Rollback

If anything in Stage F fails:

```bash
launchctl bootout gui/$(id -u)/com.jibot.nanoclaw 2>&1 || true
launchctl bootout gui/$(id -u)/com.nanoclaw.iblai-router 2>&1 || true

# Reverse the moves
mv ~/nanoclaw ~/nanoclaw-merge
mv ~/nanoclaw-1.x ~/nanoclaw

# Restore plists from the .bak-pre-rename snapshots
for p in com.jibot.nanoclaw com.jibot.qmd-fleet com.jibot.tcp-mcp-bridge \
         com.nanoclaw.iblai-router; do
  cp ~/Library/LaunchAgents/$p.plist.bak-pre-rename \
     ~/Library/LaunchAgents/$p.plist
done

# Re-enable the two disabled plists
mv ~/Library/LaunchAgents/disabled-pre-rename/com.jibot.access-audit.plist \
   ~/Library/LaunchAgents/
mv ~/Library/LaunchAgents/disabled-pre-rename/com.jibot.ipc-lifecycle.plist \
   ~/Library/LaunchAgents/

# Bootstrap everything back
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jibot.nanoclaw.plist
# ... etc.
```

## Risks and unknowns

- **Container mounts**: any nanoclaw-v2-* container running during
  Stage C dies because its bind mounts vaporize. Stage B step 3
  pre-empts this; don't skip it.
- **Sidecar state file path**: the email-state JSON file path is
  derived from `process.cwd()` (`/Users/jibot/nanoclaw-merge/data/...`).
  After rename, the new daemon will look at
  `~/nanoclaw/data/email-state-*.json` — which is the same file
  bytes (the directory just got renamed). Should Just Work, but
  worth verifying in Stage F.
- **Symlinks**: `~/nanoclaw-merge` is not symlinked from anywhere
  I've found in this audit. If you have shell aliases / IDE
  workspaces / dotfiles referencing the old name, those will break
  after the rename. Quick scan suggestion before Stage A:
  ```bash
  grep -rl 'nanoclaw-merge' ~/.zshrc ~/.bashrc ~/.bash_profile \
                            ~/.config 2>/dev/null
  ```
- **The two QMD plist no-op edits** in D3 — they look like no-ops
  but pre-rename they pointed at the (about-to-disappear)
  `~/nanoclaw/` 1.x tree, post-rename at the (now-canonical) merge
  tree. The script content is identical; the mounted process
  interprets `$HOME/.config/qmd/fleet.yaml` either way. Safe.
- **Claude Code session**: this very session is anchored to
  `~/nanoclaw-merge`. After rename, **start a new Claude Code
  session in `~/nanoclaw`**. Old session can still resume but is
  pinned to the old project name.

## Estimated total downtime

Daemon down: ~30 seconds. Aux services down: ~60 seconds. Email
adapter polls every 30s, so no inbound is lost — the next poll picks
up anything that arrived during the gap. Outbound delivery: anything
queued in messages_out delivers on the next poll cycle.

## What I'd change in this plan if I were the operator

- Do this on a quiet morning when you're not expecting urgent mail
  or Slack pings during the 90-second window.
- Don't combine with any other operational change in the same
  session — keep it pure rename.
- Make sure macazbd's syncthing isn't mid-sync of a large file
  when you stop the daemon (low risk, but the email-intake-log.md
  could see a write race during the gap).
