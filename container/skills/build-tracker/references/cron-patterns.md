# Build Tracker — Cron Patterns & Examples

## Common Schedules

| Cadence | Cron Expr | Use case |
|---------|-----------|----------|
| Every 4h | `0 */4 * * *` | Active build (daily build sprints) |
| Every 2h | `0 */2 * * *` | Hot build (shipping today) |
| Every 6h | `0 */6 * * *` | Background / maintenance build |
| Business hours | `0 9,12,15,18 * * 1-5` | Office hours only |

## Wiring a New Tracker

```bash
# Minimal
bash ~/d/popashot-agent/skills/build-tracker/scripts/wire-cron.sh \
  owner/repo \
  <discord-channel-id> \
  "0 */4 * * *"

# With phase tracking
bash ~/d/popashot-agent/skills/build-tracker/scripts/wire-cron.sh \
  owner/repo \
  <discord-channel-id> \
  "0 */4 * * *" \
  --phases-file ~/d/popashot-agent/state/myproject-phases.json \
  --stale-pr-hours 2 \
  --stale-issue-hours 6 \
  --label "popashot/myproject.build-tracker"
```

## Phase File Format

Optional JSON file that maps phases to GitHub issue numbers:

```json
[
  {
    "name": "Phase 1: Bug Fixes",
    "issues": [1, 2, 3]
  },
  {
    "name": "Phase 2: New Features",
    "issues": [4, 5]
  }
]
```

Place in: `~/d/popashot-agent/state/<project>-phases.json`

## Agent Mention Mapping

The tracker script outputs raw GitHub login names. When posting to Discord, map them:

| GitHub | Discord mention |
|--------|----------------|
| cantona / bot-cantona | `<@1473686517388939431>` |
| splinter / bot-splinter | `<@1473718900905476374>` |
| velma / bot-velma | `<@1473707958335439074>` |
| zerocool / bot-zerocool | `<@1473717920772128871>` |
| tank / bot-tank | `<@1473711121721462945>` |
| stevengonsalvez | `<@788525330818007100>` |

## Removing a Tracker

When a project is done (UAT passed, all phases closed):

```python
# Remove job from cron
import json
with open('/Users/stevengonsalvez/.openclaw/cron/jobs.json', 'r') as f:
    data = json.load(f)
label = "popashot/myproject.build-tracker"
data['jobs'] = [j for j in data['jobs'] if j.get('name') != label]
with open('/Users/stevengonsalvez/.openclaw/cron/jobs.json', 'w') as f:
    json.dump(data, f, indent=2)
print("Removed", label)
```

## Staleness Thresholds

| Phase status | Stale PR | Stale Issue |
|-------------|----------|-------------|
| Active sprint | 2h | 4h |
| Normal build | 4h | 8h |
| Background | 8h | 24h |

## Cost Model

This skill is designed to be near-zero cost:
- **Script phase**: pure `gh` CLI calls — no LLM, no tokens
- **TRACKER_OK path**: agent replies `HEARTBEAT_OK` (~50 tokens)
- **TRACKER_ALERT path**: agent formats + posts findings (~200-400 tokens on sonnet)
- **Expected cost per run**: <$0.001 when silent, ~$0.005 when alerting
