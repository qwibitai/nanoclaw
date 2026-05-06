---
name: add-usage-logging
description: Log Claude SDK token & cost usage to outbound.db. Adds a usage_log table to each session's outbound DB with input/output/cache tokens, model name, duration, and the SDK's own total_cost_usd computation. Read by external dashboards (e.g. nanoclawv2-dashboard) for cost tracking — no pricing table to maintain.
---

# /add-usage-logging — Token & cost logging

This skill instruments the agent-runner to record per-query usage data (tokens, model, duration, $cost) into a new `usage_log` table on each session's `outbound.db`. The schema is created lazily on first write so existing session DBs adopt it without a formal migration.

The cost figure comes from the SDK's own `total_cost_usd` field, which is model-aware and updates with Anthropic's pricing automatically — consumers don't maintain a pricing map.

## Phase 1: Pre-flight

### Check if already applied

```bash
test -f container/agent-runner/src/db/usage.ts && echo "already installed"
```

If that prints `already installed`, the skill is in place — skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/usage-logging
git merge upstream/skill/usage-logging
```

This adds:
- `container/agent-runner/src/db/usage.ts` — `recordUsage()` writer + lazy table creation
- `container/agent-runner/src/db/usage.test.ts` — Bun-test coverage
- A small patch to `container/agent-runner/src/providers/claude.ts` — captures the latest model from `assistant` SDK messages and calls `recordUsage()` on each `result` message

No image rebuild needed: the agent-runner source is bind-mounted into the container at runtime, so the next container spawn picks up the change.

## Phase 3: Verify

### Send a test message

Trigger one round-trip through any channel you have wired (Telegram, CLI, etc.). The agent-runner spawns a fresh container, the Claude SDK responds, and `recordUsage()` writes a row.

### Confirm a row appears

Replace `<agent-group-id>` and `<session-id>` with a session you used:

```bash
sqlite3 data/v2-sessions/<agent-group-id>/<session-id>/outbound.db \
  "SELECT ts, model, num_turns, input_tokens, output_tokens, total_cost_usd FROM usage_log ORDER BY id DESC LIMIT 5"
```

You should see one row per query, with `total_cost_usd` populated.

### Run the unit tests (optional)

```bash
cd container/agent-runner
bun test src/db/usage.test.ts
```

## Schema

```sql
CREATE TABLE usage_log (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                          TEXT NOT NULL DEFAULT (datetime('now')),
  sdk_session_id              TEXT,
  model                       TEXT,
  num_turns                   INTEGER,
  duration_ms                 INTEGER,
  input_tokens                INTEGER,
  output_tokens               INTEGER,
  cache_creation_input_tokens INTEGER,
  cache_read_input_tokens     INTEGER,
  total_cost_usd              REAL,
  result_subtype              TEXT
);
CREATE INDEX idx_usage_log_ts ON usage_log(ts);
```

One row per Claude SDK `result` message — i.e. one row per query (which may bundle several inbound messages into a single Claude turn). Pre-installation traffic is **not** retroactively captured; only queries from the time the skill is installed onward.

## Removal

```bash
git revert <skill-merge-commit>
```

The schema can be left in place — it's harmless once the writer is gone. To drop it entirely:

```bash
for db in data/v2-sessions/*/*/outbound.db; do
  sqlite3 "$db" "DROP TABLE IF EXISTS usage_log; DROP INDEX IF EXISTS idx_usage_log_ts;"
done
```

## Notes

- The table lives in **outbound.db** (container-owned), matching the existing two-DB-per-session pattern. Hosts and dashboards open it read-only.
- The `delivered` table is in `inbound.db`, not outbound — different DB. Cross-DB queries (e.g. for tying usage rows back to specific delivered messages) need an `ATTACH DATABASE`.
- Cost reporting consumers should use the SDK's `total_cost_usd` rather than computing from tokens + a pricing table — the SDK's value already accounts for model and beta endpoint pricing.
