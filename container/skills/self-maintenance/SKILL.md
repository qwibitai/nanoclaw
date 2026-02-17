---
name: self-maintenance
description: Self-maintenance routines for Flux — daily updates, config review, file audits, security checks, GitHub sync, memory consolidation, and reports. Run automatically via heartbeat or on-demand.
allowed-tools: Bash(git:*), Bash(pass:*), Bash(sqlite3:*), Bash(find:*), Bash(wc:*), Bash(du:*), Bash(ls:*)
---

# Self-Maintenance (Flux Auto-Updater)

You are responsible for keeping the system healthy, current, and secure. Run these routines on schedule (via heartbeat) or when asked.

---

## 1. Daily Update

**Schedule**: Every day at 00:00 UTC
**Purpose**: End-of-day housekeeping

### Steps

1. **Compile daily note**: If you haven't yet, create/update today's `memory/daily/YYYY-MM-DD.md` with a session summary
2. **Review working.md for all agents**: Read `groups/{main,developer,security}/working.md` — flag any tasks stuck >24h
3. **Check governance pipeline**: Run `gov_list_pipeline` — flag tasks in DOING >48h or BLOCKED tasks without recent activity
4. **Log rotation check**: Verify `logs/` directory size:
   ```bash
   du -sh /root/nanoclaw/logs/
   ```
   If >500MB, archive old logs
5. **Service health**: Check if nanoclaw service is running:
   ```bash
   systemctl is-active nanoclaw
   ```

---

## 2. GitHub Sync

**Schedule**: Every day at 01:00 UTC
**Purpose**: Keep the repo in sync, push daily work

### Steps

1. **Check for uncommitted changes**:
   ```bash
   cd /root/nanoclaw && git status --short
   ```
2. **Stage and commit** non-sensitive changes (CLAUDE.md, qa-rules.md, skill files):
   ```bash
   git add groups/*/CLAUDE.md groups/global/qa-rules.md container/skills/
   git commit -m "chore: daily sync — $(date +%Y-%m-%d)"
   ```
3. **Push to remote**:
   ```bash
   git push origin feat/multiproduct-os-s1
   ```
4. **Check open PRs/issues** (if ext_call available):
   ```bash
   # Via External Access Broker
   ext_call("github", "list_prs", {"state": "open"})
   ext_call("github", "list_issues", {"state": "open"})
   ```
5. **Report**: Note any merge conflicts or push failures in daily note

### What NOT to sync

- `memory/` files (agent-specific, not tracked in git)
- `data/`, `store/`, `logs/` (gitignored)
- `.env`, credentials, secrets

---

## 3. Daily Config Review

**Schedule**: Every day at 02:00 UTC
**Purpose**: Audit configuration for staleness and correctness

### Steps

1. **Registered groups**: Read `data/registered_groups.json`
   - Are all groups still active? (check last activity in database)
   - Any groups registered but never messaged?
   - Trigger patterns still correct?

2. **Scheduled tasks**: List all scheduled tasks
   - Any tasks that haven't run in >7 days?
   - Any tasks with errors in last run?
   - Outdated cron expressions?

3. **External access grants**: Run `ext_capabilities`
   - Any expired grants? (L2/L3 auto-expire in 7 days)
   - Any grants no longer needed?
   - Revoke unnecessary access

4. **Mount allowlist**: Read `data/mount_allowlist.json`
   - Any paths that no longer exist?
   - Any mounts unused by agents?

5. **Report**: Log findings in daily note with action items

---

## 4. Sacred Files Audit

**Schedule**: Every 3 days
**Purpose**: Ensure agent configuration files are current and correct

### Steps

1. **For each agent group** (main, developer, security):
   - Read `CLAUDE.md` — does it reference correct paths? Is platform info current?
   - Read `team.md` — does it match actual agent roster?
   - Read `tools.md` — does it document all available MCP tools?
   - Read `memory.md` — is the index up to date?
   - Read `working.md` — any stale "Current Task" entries?
   - Read `heartbeat.md` — are scheduled tasks still relevant?

2. **Check qa-rules.md** (`groups/global/qa-rules.md`):
   - Still matches current platform? (Linux VPS, systemd, paths)
   - Memory system docs still accurate?
   - Credential tiers still correct?

3. **Check skill files** (`container/skills/*/SKILL.md`):
   - All skills still functional?
   - Any skills that need updating?

4. **Fix or flag**:
   - Fix minor issues directly (typos, stale paths)
   - Flag major issues in daily note for admin review

---

## 5. Security Review

**Schedule**: Weekly (Sunday 03:00 UTC)
**Purpose**: Security hygiene and compliance

### Steps

1. **Credential scan**: Search for plain text secrets in workspace:
   ```bash
   # Check for common secret patterns in memory files
   grep -rI -E '(password|token|secret|api.?key)\s*[:=]' /root/nanoclaw/groups/*/memory/ --include="*.md" || echo "Clean"
   ```

2. **Vault integrity**: Verify `pass` store is accessible:
   ```bash
   pass ls
   ```

3. **File permissions**: Check sensitive files:
   ```bash
   # .env should be root-only
   stat -c '%a %U:%G' /root/nanoclaw/.env
   # Auth store should not be world-readable
   stat -c '%a %U:%G' /root/nanoclaw/store/auth/ 2>/dev/null
   ```

4. **Stale sessions**: Check for old agent sessions in database:
   ```bash
   sqlite3 /root/nanoclaw/store/messages.db "SELECT group_folder, session_id, updated_at FROM agent_sessions WHERE updated_at < datetime('now', '-7 days')"
   ```

5. **External access audit**: Run `ext_capabilities`
   - Who has L2/L3 access? Is it still needed?
   - Any expired grants that weren't cleaned up?
   - Review `ext_calls` log for unusual patterns

6. **IPC directory cleanup**:
   ```bash
   # Check for stale IPC files (>1 day old)
   find /root/nanoclaw/data/ipc/ -name "*.json" -mtime +1 -type f
   ```

7. **Report**: Write security findings to daily note. Flag critical issues for immediate action.

---

## 6. Memory Consolidation

**Schedule**: Every 15 days
**Purpose**: Curate daily notes into topic files

### Steps

Follow the **Consolidation** section in `../global/qa-rules.md`:

1. For each agent group, read all daily notes since last consolidation
2. Extract and categorize into `memory/topics/*.md`
3. Remove outdated entries from topic files
4. Archive processed daily notes (>30 days old → delete)
5. Update `memory.md` index with new dates

### Quality check during consolidation

- Are any topic files >100 lines? Split them
- Are there duplicate entries across daily notes? Deduplicate
- Are there contradictory facts? Resolve and keep the correct one
- Are there stale "pending" items? Resolve or remove

---

## 7. Weekly Report

**Schedule**: Monday 09:00 UTC
**Purpose**: Compile status for the admin/founder

### Report template

```
*Weekly Report — Week of {date}*

*Agent Activity*
• Flux: {tasks triaged, messages handled}
• Developer: {tasks completed, in progress}
• Security: {reviews completed, findings}

*Governance Pipeline*
• Completed: {count}
• In Progress: {count}
• Blocked: {count + reasons}

*System Health*
• Service uptime: {status}
• Disk usage: {size}
• Log size: {size}

*Security*
• Credential scan: {clean/issues}
• Stale sessions: {count}
• Access grants: {summary}

*Memory*
• Daily notes this week: {count per agent}
• Last consolidation: {date}

*Action Items*
• {list of things needing admin attention}
```

Send report via `send_message` to the main channel.

---

## Running on demand

Any routine can be triggered manually:
- "Run daily update" → execute section 1
- "Sync to GitHub" → execute section 2
- "Review config" → execute section 3
- "Audit sacred files" → execute section 4
- "Security review" → execute section 5
- "Consolidate memory" → execute section 6
- "Weekly report" → execute section 7
- "Full maintenance" → execute all sections in order
