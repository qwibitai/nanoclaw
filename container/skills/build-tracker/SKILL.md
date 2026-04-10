---
name: build-tracker
description: Set up a recurring build tracker cron job for any GitHub repo. Runs a zero-LLM shell script to detect stale PRs, stale assigned issues, and phase progress, then posts to a Discord channel only when there's something actionable. Use when asked to "track this build every N hours", "prod agents on a project", "set up a build monitor", "watch this repo for stale work", or similar. The tracker is cheap to run — script does all the work, the agent only speaks when findings exist.
---

# Build Tracker Skill

## What This Skill Does

Wires a periodic cron that:
1. Runs `scripts/run-tracker.sh` — pure `gh` CLI, no LLM calls
2. If `TRACKER_OK`: agent replies `HEARTBEAT_OK`, stays silent
3. If `TRACKER_ALERT`: agent posts a brief findings summary to Discord + mentions relevant agents

**Cost**: ~$0 when silent (HEARTBEAT_OK path), ~$0.005 per alert on sonnet.

---

## Wire a New Tracker

### Quick (no phases)

```bash
bash ~/d/popashot-agent/skills/build-tracker/scripts/wire-cron.sh \
  <owner/repo> \
  <discord-channel-id> \
  "<cron-expr>"
```

### With phase tracking

```bash
bash ~/d/popashot-agent/skills/build-tracker/scripts/wire-cron.sh \
  <owner/repo> \
  <discord-channel-id> \
  "<cron-expr>" \
  --phases-file ~/d/popashot-agent/state/<project>-phases.json \
  --stale-pr-hours 2 \
  --stale-issue-hours 6 \
  --label "popashot/<project>.build-tracker"
```

**Defaults**: stale-pr-hours=4, stale-issue-hours=8, label=`popashot/<repo-slug>.build-tracker`

---

## Run Manually

```bash
STALE_PR_HOURS=4 STALE_ISSUE_HOURS=8 \
  bash ~/d/popashot-agent/skills/build-tracker/scripts/run-tracker.sh owner/repo
```

Exit 0 = nothing actionable. Exit 1 = findings present (check stdout).

---

## Cron Payload Template

The `wire-cron.sh` script injects this pattern automatically. The cron message is:

> Run tracker script → read output → if TRACKER_OK: HEARTBEAT_OK → if TRACKER_ALERT: post summary to channel, mention relevant agents, one message.

Model is always `sonnet`. Session is always `isolated`.

---

## Removing a Tracker

When a project is done (UAT passed, all phases closed):

```python
import json
with open('/Users/stevengonsalvez/.openclaw/cron/jobs.json', 'r') as f:
    data = json.load(f)
label = "popashot/<project>.build-tracker"
data['jobs'] = [j for j in data['jobs'] if j.get('name') != label]
with open('/Users/stevengonsalvez/.openclaw/cron/jobs.json', 'w') as f:
    json.dump(data, f, indent=2)
```

---

## References

- **Cron patterns, phase file format, agent mention map, cost model**: See `references/cron-patterns.md`
- **Script details**: `scripts/run-tracker.sh` (pure bash/python, no LLM)
- **Wiring script**: `scripts/wire-cron.sh` (modifies `~/.openclaw/cron/jobs.json`)

---

## Design Principles

- **Script-first**: `run-tracker.sh` does all data gathering — `gh` CLI only
- **Silent by default**: Only speaks when stale/blocked work exists
- **Skip blocked issues**: Labels `parked`, `blocked`, `needs-approval`, `later`, `in-review` are ignored
- **Unassigned issues are not stale**: Only assigned issues count as stale
- **Always backup** `~/.openclaw/cron/jobs.json` before modifying (wire-cron.sh does this automatically)
