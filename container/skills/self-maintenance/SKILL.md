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

1. **For each registered agent group** (query DB, not hardcoded):
   ```bash
   sqlite3 /root/nanoclaw/store/messages.db "SELECT folder, name FROM registered_groups ORDER BY folder"
   ```
   For each group folder, check:
   - Read `CLAUDE.md` — does it reference correct paths? Is platform info current?
   - Read `team.md` — does it match actual agent roster? Is the symlink valid?
   - Read `tools.md` — does it document all available MCP tools?
   - Read `memory.md` — is the index up to date?
   - Read `working.md` — any stale "Current Task" entries?
   - Read `heartbeat.md` — are scheduled tasks still relevant?
   - Verify `memory/daily/` and `memory/topics/` directories exist

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

*Provider Health*
• Providers registered: {count}
• Status: {HEALTHY/DEGRADED/DOWN per provider}
• Failures (7d): {total failures / total calls = %rate}
• Auto-fixes: {expired revoked, stuck timeouts, unused cleaned}
• Admin action needed: {list or "none"}

*Performance Review*
• {Agent}: {overall}/5 {↑/→/↓} — {decision} {reason if promote/demote/warning}
• {repeat for each agent}

*Memory*
• Daily notes this week: {count per agent}
• Last consolidation: {date}

*Action Items*
• {list of things needing admin attention}
```

Send report via `send_message` to the main channel.

---

## 8. Provider Health Check

**Schedule**: Every day at 02:30 UTC (after Config Review)
**Purpose**: Monitor external API plugins, detect failures, auto-fix what's possible

### Step 1: Failure rate by provider (last 24h)

```bash
sqlite3 /root/nanoclaw/store/messages.db "
  SELECT provider, action,
    COUNT(*) as total,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failures,
    SUM(CASE WHEN status='denied' THEN 1 ELSE 0 END) as denials,
    ROUND(AVG(duration_ms)) as avg_ms
  FROM ext_calls
  WHERE created_at > datetime('now', '-1 day')
  GROUP BY provider, action
  ORDER BY failures DESC;
"
```

**Thresholds**:
- Failure rate >30% on any action → flag as DEGRADED in daily note
- Failure rate >80% → flag as DOWN, alert admin immediately
- Avg duration >10s → flag as SLOW

### Step 2: Expired capabilities (auto-fix)

```bash
sqlite3 /root/nanoclaw/store/messages.db "
  SELECT group_folder, provider, access_level, expires_at
  FROM ext_capabilities
  WHERE active = 1
    AND expires_at IS NOT NULL
    AND expires_at < datetime('now');
"
```

**Auto-fix**: Revoke expired capabilities immediately:
```
ext_revoke(group_folder="...", provider="...")
```

### Step 3: Capabilities expiring soon (auto-renew)

```bash
sqlite3 /root/nanoclaw/store/messages.db "
  SELECT group_folder, provider, access_level, expires_at
  FROM ext_capabilities
  WHERE active = 1
    AND expires_at IS NOT NULL
    AND expires_at BETWEEN datetime('now') AND datetime('now', '+2 days');
"
```

**Auto-fix**: If the capability is still needed (check recent ext_calls in last 7 days), renew with `ext_grant` using the same parameters. If unused, let it expire.

### Step 4: Stuck processing calls (auto-fix)

```bash
sqlite3 /root/nanoclaw/store/messages.db "
  SELECT request_id, group_folder, provider, action, created_at
  FROM ext_calls
  WHERE status = 'processing'
    AND created_at < datetime('now', '-1 hour');
"
```

**Auto-fix**: Mark stuck calls as timeout:
```bash
sqlite3 /root/nanoclaw/store/messages.db "
  UPDATE ext_calls SET status = 'timeout'
  WHERE status = 'processing'
    AND created_at < datetime('now', '-1 hour');
"
```

Also clean up their response files to unblock the group's pending count.

### Step 5: Unused capabilities (flag for cleanup)

```bash
sqlite3 /root/nanoclaw/store/messages.db "
  SELECT c.group_folder, c.provider, c.access_level, c.granted_at
  FROM ext_capabilities c
  LEFT JOIN ext_calls e
    ON c.group_folder = e.group_folder
    AND c.provider = e.provider
    AND e.created_at > datetime('now', '-30 days')
  WHERE c.active = 1
  GROUP BY c.group_folder, c.provider
  HAVING COUNT(e.id) = 0;
"
```

**Action**: If a capability has zero calls in 30 days, revoke it. Less surface = more secure.

### Step 6: Stale response files (auto-fix)

```bash
find /root/nanoclaw/data/ipc/*/responses/ -name "*.json" -mtime +1 -type f -delete 2>/dev/null
```

### Step 7: Provider availability summary

After all checks, compile a status per provider:

| Status | Meaning | Action |
|--------|---------|--------|
| HEALTHY | <30% failures, <10s avg | None |
| DEGRADED | 30-80% failures OR >10s avg | Log warning, monitor next cycle |
| DOWN | >80% failures | Alert admin, consider revoking grants temporarily |
| EXPIRED | All capabilities expired | Auto-revoked, log |
| UNUSED | Zero calls in 30 days | Auto-revoked, log |

Log the summary in today's daily note under `## Provider Health`.

### What Flux CAN auto-fix

- Revoke expired capabilities
- Renew expiring capabilities that are still in use
- Mark stuck processing calls as timeout
- Clean stale response files
- Revoke unused capabilities (30+ days idle)

### What needs admin (flag in daily note)

- Provider returning >80% failures → likely bad secret or API change
- Missing secrets (provider disabled at startup) → admin must update `.env`
- Provider code bugs → admin must edit `src/ext-providers/` (see `docs/runbooks/add-provider.md`)
- New provider requests from agents → admin follows runbook

---

## 9. Performance Review

**Schedule**: Weekly (Sunday 20:00 UTC, before Monday weekly report)
**Purpose**: Evaluate agent performance, decide promotions/demotions, absorb learnings

You are the CRO (Chief Review Officer). Every week you assess each agent's work objectively, using governance data as the primary evidence. Your reviews are fair, data-driven, and action-oriented.

### Step 1: Collect metrics per agent (last 7 days)

For each registered agent (query DB, not hardcoded):

```bash
sqlite3 /root/nanoclaw/store/messages.db "SELECT folder, name FROM registered_groups WHERE folder != 'main' ORDER BY folder"
```

For each agent, run these queries:

#### 1a. Throughput — tasks completed

```bash
sqlite3 /root/nanoclaw/store/messages.db "
  SELECT COUNT(*) FROM gov_tasks
  WHERE assigned_group = '{folder}'
    AND state = 'DONE'
    AND updated_at > datetime('now', '-7 days');
"
```

#### 1b. Cycle time — avg DOING→REVIEW duration (hours)

```bash
sqlite3 /root/nanoclaw/store/messages.db "
  SELECT ROUND(AVG(
    (julianday(r.created_at) - julianday(d.created_at)) * 24
  ), 1) as avg_hours
  FROM gov_activities d
  JOIN gov_activities r ON d.task_id = r.task_id
  WHERE d.action = 'transition' AND d.to_state = 'DOING'
    AND r.action = 'transition' AND r.from_state = 'DOING' AND r.to_state = 'REVIEW'
    AND d.actor = '{folder}'
    AND d.created_at > datetime('now', '-7 days');
"
```

#### 1c. Rework rate — tasks sent back from REVIEW/APPROVAL to DOING

```bash
sqlite3 /root/nanoclaw/store/messages.db "
  SELECT COUNT(DISTINCT task_id) as reworks
  FROM gov_activities
  WHERE action = 'transition'
    AND to_state = 'DOING'
    AND from_state IN ('REVIEW', 'APPROVAL')
    AND task_id IN (
      SELECT id FROM gov_tasks WHERE assigned_group = '{folder}'
    )
    AND created_at > datetime('now', '-7 days');
"
```

#### 1d. Block rate — tasks moved to BLOCKED by this agent

```bash
sqlite3 /root/nanoclaw/store/messages.db "
  SELECT COUNT(DISTINCT task_id) as blocks
  FROM gov_activities
  WHERE action = 'transition'
    AND to_state = 'BLOCKED'
    AND actor = '{folder}'
    AND created_at > datetime('now', '-7 days');
"
```

#### 1e. External API efficiency

```bash
sqlite3 /root/nanoclaw/store/messages.db "
  SELECT
    COUNT(*) as total_calls,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failures,
    SUM(CASE WHEN status='denied' THEN 1 ELSE 0 END) as denials
  FROM ext_calls
  WHERE group_folder = '{folder}'
    AND created_at > datetime('now', '-7 days');
"
```

#### 1f. Memory contributions

```bash
sqlite3 /root/nanoclaw/store/messages.db "
  SELECT COUNT(*) as memories_stored
  FROM memories
  WHERE source_ref LIKE '%{folder}%'
    AND created_at > datetime('now', '-7 days');
"
```

### Step 2: Score each dimension (1-5)

| Dimension | What to measure | Score guide |
|-----------|----------------|-------------|
| **Quality** | Rework rate, approval-on-first-try rate | 5: 0% rework, 4: <10%, 3: 10-25%, 2: 25-50%, 1: >50% |
| **Speed** | Cycle time vs task size, throughput | 5: consistently fast, 4: above avg, 3: on-par, 2: slow, 1: stuck |
| **Proactivity** | Early blocker detection, memory contributions, unsolicited improvements | 5: regularly anticipates, 4: sometimes, 3: does what's asked, 2: passive, 1: ignores signals |
| **Adherence** | Governance compliance, working.md updates, sacred file usage | 5: exemplary, 4: minor gaps, 3: mostly compliant, 2: frequent violations, 1: ignores governance |
| **Cost-Benefit** | Ext API usage efficiency, task-to-output ratio | 5: highly efficient, 4: good, 3: normal, 2: wasteful, 1: excessive cost/low output |

**Overall score**: Weighted average → Quality(30%) + Speed(25%) + Proactivity(15%) + Adherence(20%) + Cost-Benefit(10%)

### Step 3: Compare with previous review

Read `memory/topics/performance.md` for the agent's last review. Calculate trend:

| Trend | Condition |
|-------|-----------|
| ↑ Rising | Overall improved by ≥0.5 |
| → Stable | Change < 0.5 |
| ↓ Declining | Overall dropped by ≥0.5 |

### Step 4: Decision

| Overall Score | Trend | Decision | Action |
|---------------|-------|----------|--------|
| ≥4.0 | ↑ Rising | **Promote** | Upgrade level in team.md, note reason |
| ≥4.0 | → Stable | **Maintain** | Acknowledge excellence |
| 3.0-3.9 | Any | **Maintain** | Note areas for improvement |
| 2.0-2.9 | ↓ Declining | **Warning** | Create improvement task, set 2-week deadline |
| <2.0 | Any | **Demote** | Downgrade level, restrict access, review role |
| <2.0 | ↓ Declining (2+ weeks) | **Suspend** | Pause dispatches, flag for admin review |

**Level changes**:
- Observer → Advisor → Operator → Autonomous (only Flux should be Autonomous)
- Max one level change per review (no jumping Observer→Operator)
- Demotions are immediate, promotions require 2 consecutive qualifying reviews

### Step 5: Write the review

For each agent, write a review entry. Append to `memory/topics/performance.md`:

```markdown
### {Agent Name} — Week of {date}

| Dimension | Score | Notes |
|-----------|-------|-------|
| Quality | {1-5} | {evidence} |
| Speed | {1-5} | {evidence} |
| Proactivity | {1-5} | {evidence} |
| Adherence | {1-5} | {evidence} |
| Cost-Benefit | {1-5} | {evidence} |
| **Overall** | **{weighted}** | **Trend: {↑/→/↓}** |

**Decision**: {Promote/Maintain/Warning/Demote}
**Action**: {what was done or needs doing}
**Learnings absorbed**: {key insights from this agent's work this week}
```

### Step 6: Apply decisions

- **Promote**: Update `groups/global/team.md` level column. Update agent's `CLAUDE.md` if it references level. Store a `store_memory` with tags `["performance", "promotion"]`.
- **Demote**: Same as promote but downward. Create a governance task for the agent with improvement criteria.
- **Warning**: Create a governance task: "Improvement Plan: {agent}" assigned to the agent, with specific targets.
- **Maintain**: No changes. Log the review.

### Step 7: Absorb learnings

After reviewing all agents, reflect:

1. **Cross-agent patterns**: Are multiple agents struggling with the same thing? → systemic issue, not individual
2. **Best practices**: Did any agent discover a better approach? → propagate via `store_memory(content, tags=["pattern", "best-practice"], level=0)`
3. **Knowledge gaps**: Is training material missing? → create a skill or update qa-rules.md
4. **Workload balance**: Is one agent overloaded while another is idle? → redistribute in next sprint

Store a weekly learning summary in daily note under `## Performance Review Learnings`.

### Calibration notes

- **New agents** (first 2 weeks): Score Proactivity and Adherence leniently (3 = baseline). Focus on Quality and Speed.
- **Low-volume weeks**: If an agent had <3 tasks, metrics are unreliable. Note "insufficient data" and carry forward previous scores.
- **Blocked tasks**: Don't penalize agents for blocks caused by external dependencies. Only count blocks where the agent could have unblocked themselves.

---

## 10. Daily Topic Consolidation

**Schedule**: Every day at 23:00 UTC
**Scheduled task ID**: `task-daily-consolidation`
**Purpose**: Extract decisions, insights, and open questions from cockpit topics into persistent memory. Safety net for sessions that closed without explicit consolidation.

### Step 1 — Find topics with activity today

```bash
node -e "
const db = require('/root/nanoclaw/node_modules/better-sqlite3')('/root/nanoclaw/store/messages.db');
const since = new Date(); since.setUTCHours(0,0,0,0);
const rows = db.prepare('SELECT DISTINCT m.chat_jid, ct.title, ct.group_folder, COUNT(*) as msg_count FROM messages m JOIN cockpit_topics ct ON ct.id = REPLACE(m.chat_jid, \\'cockpit:\\', \\'\\') WHERE m.chat_jid LIKE \\'cockpit:%\\' AND m.timestamp >= ? AND m.is_bot_message = 0 GROUP BY m.chat_jid').all(since.toISOString());
console.log(JSON.stringify(rows, null, 2));
"
```

### Scope — both channels

Covers:
- **Cockpit topics** — `chat_jid LIKE 'cockpit:%'`
- **WhatsApp registered groups** — `chat_jid` in `registered_groups`

### Step 2 — Read today's messages (both channels)

```bash
# Cockpit topics
node -e "
const db = require('/root/nanoclaw/node_modules/better-sqlite3')('/root/nanoclaw/store/messages.db');
const since = new Date(); since.setUTCHours(0,0,0,0);
const rows = db.prepare('SELECT chat_jid, sender_name, content, timestamp FROM messages WHERE chat_jid LIKE \\'cockpit:%\\' AND timestamp >= ? AND is_bot_message = 0 ORDER BY chat_jid, timestamp').all(since.toISOString());
console.log(JSON.stringify(rows, null, 2));
"

# WhatsApp registered groups
node -e "
const db = require('/root/nanoclaw/node_modules/better-sqlite3')('/root/nanoclaw/store/messages.db');
const since = new Date(); since.setUTCHours(0,0,0,0);
const rows = db.prepare('SELECT m.chat_jid, rg.name as group_name, m.sender_name, m.content, m.timestamp FROM messages m JOIN registered_groups rg ON rg.jid = m.chat_jid WHERE m.timestamp >= ? AND m.is_bot_message = 0 ORDER BY m.chat_jid, m.timestamp').all(since.toISOString());
console.log(JSON.stringify(rows, null, 2));
"
```

### Step 3 — Extract and store to memory

For each conversation (Cockpit or WhatsApp) with substantive content today:

1. Identify:
   - **Decisions** — "decidimos", "vamos usar", "escolhemos", "aprovado", "ficou decidido", "será X"
   - **Insights** — non-obvious conclusions, validated hypotheses, key learnings
   - **Action items** — things agreed to be done
   - **Open questions** — "ficou em aberto", "precisamos validar", "ainda não sabemos"

2. Store with `store_memory`:
   - Cockpit: `tags=["decision|learning|action|pending", "topic-consolidation", "topic:{title}"]`
   - WhatsApp: `tags=["decision|learning|action|pending", "whatsapp-consolidation", "group:{name}"]`
   - Always: `source_ref = "daily-consolidation-{YYYY-MM-DD}"`

3. Skip trivial conversations (greetings, one-word confirmations, test messages).

### Step 4 — Update daily note

Append to `memory/daily/{YYYY-MM-DD}.md`:

```
## Daily Consolidation — {HH:MM} UTC

### Cockpit Topics — {N} reviewed, {N} items stored
| Topic | Decisions | Insights | Pending |
|-------|-----------|---------|---------|
| {title} | {N} | {N} | {N} |

### WhatsApp Groups — {N} reviewed, {N} items stored
| Group | Decisions | Insights | Pending |
|-------|-----------|---------|---------|
| {name} | {N} | {N} | {N} |
```

If no activity in either channel: append one line — "No conversation activity to consolidate." Do not message the channel.

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
- "Provider health check" → execute section 8
- "Performance review" → execute section 9
- "Consolidate conversations" → execute section 10
- "Full maintenance" → execute all sections in order
