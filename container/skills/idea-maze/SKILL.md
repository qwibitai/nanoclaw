---
name: idea-maze
description: Run Idea Maze research pipeline — harvest sources, extract insights, cluster opportunities, draft research. Use when the user mentions harvesting, ingesting, insights, opportunities, research pipeline, or scoring.
---

# Idea Maze Research Pipeline

You manage the Idea Maze product discovery pipeline. All domain data lives in `/workspace/group/data/lab.db` (separate from NanoClaw's messages.db).

## Running Scripts

All scripts are at `/workspace/group/scripts/`. Run them with:

```bash
cd /workspace/group/scripts && tsx <script>.ts [args]
```

## Available Scripts

### Database
- `init-db.ts` — Initialize/migrate lab.db schema (safe to re-run)

### Ingestion
- `ingest-reddit.ts` — Harvest from configured subreddits

### Analysis
- `extract-insights.ts` — Extract typed insights from unprocessed source items (LLM + heuristic fallback)
- `refresh-opportunities.ts` — Cluster insights into opportunities by keyword

### Research
- `research-opportunity.ts <slug>` — Draft research for an opportunity (lands in review_gate)

### Review Gate
- `approve-run.ts <run_id> [notes]` — Approve a run, write Markdown artifact
- `reject-run.ts <run_id> [notes]` — Reject a run, record decision

## Long-running Operations

Before executing any script that takes more than a few seconds (pipeline, research, insight extraction), **always send an immediate acknowledgment first**:

```
Call mcp__nanoclaw__send_message with text like "⏳ Running pipeline..." before executing the script.
```

This lets the user know the request was received while the work runs.

## Pipeline Stages

1. **Harvest** — Ingest from Reddit → `source_items` with harvest scores
2. **Insights** — Extract typed signals: pain_point, demand_signal, workflow_gap, distribution_clue, willingness_to_pay, competitor_move, implementation_constraint
3. **Opportunities** — Cluster insights by keyword, score by evidence + diversity
4. **Research** — Draft thesis, evidence, MVP scope, risks → lands in `review_gate`
5. **Artifacts** — On approval, render Markdown to `data/artifacts/`

## Data Locations

- Database: `/workspace/group/data/lab.db`
- Raw snapshots: `/workspace/group/data/raw/{gmail,telegram,reddit}/`
- Artifacts: `/workspace/group/data/artifacts/`

## Quick Status

```bash
cd /workspace/group/scripts && tsx -e "
import { getDb } from './lib/db.ts';
const db = getDb();
const counts = {
  sources: db.prepare('SELECT COUNT(*) as n FROM source_items').get(),
  insights: db.prepare('SELECT COUNT(*) as n FROM insights').get(),
  opportunities: db.prepare('SELECT COUNT(*) as n FROM opportunities').get(),
  pendingRuns: db.prepare(\"SELECT COUNT(*) as n FROM runs WHERE status = 'review_gate'\").get()
};
console.log(JSON.stringify(counts, null, 2));
"
```

## Common Workflows

### Full harvest
```bash
cd /workspace/group/scripts && tsx run-pipeline.ts
```

### Review pending research
```bash
cd /workspace/group/scripts && tsx -e "
import { getDb } from './lib/db.ts';
const db = getDb();
const runs = db.prepare(\"SELECT r.id, r.status, o.title FROM runs r JOIN opportunities o ON o.id = r.target_id WHERE r.status = 'review_gate'\").all();
console.log(JSON.stringify(runs, null, 2));
"
```

## Scheduling

Set up recurring jobs using `mcp__nanoclaw__schedule_task`. All tasks target the idea-maze group.

### Recommended schedule

**Full pipeline** (ingestion + insights + opportunities) — every 60 minutes:
```
prompt: "Run the full harvest pipeline. Execute: cd /workspace/group/scripts && tsx run-pipeline.ts. Report results summary."
schedule_type: interval
schedule_value: "3600000"
context_mode: isolated
script: |
  cd /workspace/group/scripts
  RESULT=$(tsx -e "import{getDb}from'./lib/db.ts';import{acquireRunLock}from'./lib/queries.ts';const db=getDb();const ok=acquireRunLock('pipeline',1800000);if(!ok){console.log('locked')}else{const n=(db.prepare(\"SELECT COUNT(*)as n FROM source_items WHERE ingested_at_utc > datetime('now','-2 hours')\").get()).n;console.log(n)}" 2>/dev/null)
  if [ "$RESULT" = "locked" ]; then
    echo '{"wakeAgent": false}'
  else
    echo '{"wakeAgent": true}'
  fi
```

**Insight extraction** — every 2 hours:
```
prompt: "Extract insights from unprocessed items. Execute: cd /workspace/group/scripts && tsx extract-insights.ts. Report how many insights were created."
schedule_type: cron
schedule_value: "0 */2 * * *"
context_mode: isolated
script: |
  cd /workspace/group/scripts
  COUNT=$(tsx -e "import{getDb}from'./lib/db.ts';import{getUnprocessedItems}from'./lib/queries.ts';console.log(getUnprocessedItems(1).length)" 2>/dev/null)
  if [ "$COUNT" = "0" ]; then
    echo '{"wakeAgent": false}'
  else
    echo '{"wakeAgent": true, "data": {"unprocessed": '$COUNT'}}'
  fi
```

**Opportunity refresh** — daily at 06:00:
```
prompt: "Refresh opportunity clusters. Execute: cd /workspace/group/scripts && tsx refresh-opportunities.ts. Send a brief summary of top 5 opportunities by score."
schedule_type: cron
schedule_value: "0 6 * * *"
context_mode: isolated
```

**Weekly digest** — Monday at 08:00:
```
prompt: "Generate a weekly digest. Query the top 10 opportunities from lab.db ordered by score. Include title, score, insight count, and top signals. Format as a concise report and send via send_message."
schedule_type: cron
schedule_value: "0 8 * * 1"
context_mode: isolated
```

**Raw cleanup** — daily at 03:00:
```
prompt: "Run raw file cleanup. Execute: cd /workspace/group/scripts && tsx cleanup-raw.ts --days 30"
schedule_type: cron
schedule_value: "0 3 * * *"
context_mode: isolated
script: |
  cd /workspace/group/scripts
  COUNT=$(find /workspace/group/data/raw -name "*.json" -mtime +30 2>/dev/null | wc -l)
  if [ "$COUNT" -eq 0 ]; then
    echo '{"wakeAgent": false}'
  else
    echo '{"wakeAgent": true, "data": {"stale_files": '$COUNT'}}'
  fi
```

### Setting up the schedule

When the user asks to "set up the pipeline schedule" or "start automation", call `mcp__nanoclaw__schedule_task` for each job above. Use `target_group_jid` if scheduling from the main chat for the idea-maze group.

### Run lock

The pipeline uses a run lock in `app_state` to prevent overlapping runs. `run-pipeline.ts` acquires/releases the lock automatically. Lock expires after 30 minutes as a safety valve.

## Configuration

Pipeline settings are stored in the `app_state` table:

| Key | Example Value | Purpose |
|-----|--------------|---------|
| `reddit_subreddits` | `["SaaS","startups","webdev"]` | Subreddits to harvest |
| `gmail_query` | `newer_than:1d -category:promotions` | Gmail search filter |
| `telegram_channels` | `["channel_username"]` | Telegram channels to follow |
