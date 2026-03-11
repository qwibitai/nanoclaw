# Session Recall Workflow

Reconstruct actionable session context quickly and reliably.

This workflow now uses two separate scripts:

1. `qmd-context-recall.sh` for recall only (search + handoff).
2. `qmd-session-sync.sh` for session export sync + `git add` + `git commit`.

## Quick Commands

```bash
# Session start (recommended, full startup flow)
bash scripts/workflow/session-start.sh --agent codex

# Session start with explicit issue
bash scripts/workflow/session-start.sh --agent codex --issue INC-123

# Recall only
qctx --bootstrap

# Recall only with explicit issue
qctx --bootstrap --issue INC-123

# Audit exported sessions for context waste
node scripts/workflow/session-context-audit.js --top 10

# While working: targeted context lookup
qctx "worker connectivity dispatch"

# Force BM25-only (fastest)
qctx --search-mode bm25 "worker connectivity dispatch"

# Force hybrid query/rerank (best ranking, slower)
qctx --search-mode hybrid "worker connectivity dispatch"

# Sync/export sessions and commit export updates
bash scripts/qmd-session-sync.sh

# Session end: write structured handoff
qctx --close \
  --issue INC-123 \
  --done "implemented watchdog guard" \
  --next "run verify-worker-connectivity and confirm review_requested" \
  --blocker "needs worker restart permission" \
  --commands "bash scripts/jarvis-ops.sh verify-worker-connectivity"

# Optional shared-context publish to Notion at close
NOTION_SESSION_SUMMARY_DATABASE_ID=<database-id> \
  qctx --close --issue INC-123 --next "pick up review lane"
```

If `qctx` alias is not installed, use:

```bash
bash scripts/qmd-context-recall.sh --bootstrap
```

## Recommended Workflow

1. Session start: run `bash scripts/workflow/session-start.sh --agent <claude|codex>`.
2. If `qmd status` warns that embeddings are pending, the main agent may spawn one background `monitor` lane dedicated to `bash scripts/qmd-session-sync.sh`. `scripts/workflow/session-start.sh` now auto-starts this background sync by default immediately after recall (disable with `--no-background-sync` or set `SESSION_SYNC_BACKGROUND=0`).
3. The main lane continues with control-plane sweep handling and workflow preflight without waiting on session sync.
4. During work: run `qctx "<topic>"` before major debug/fix loops.
5. If query precision matters, rerun with `qctx --search-mode hybrid "<topic>"`.
6. If recall quality is still degraded or stale after background sync completes, rerun recall.
7. Session end: run `qctx --close ...` with concrete `--next`.

## Context Hygiene

When the goal is to understand context pressure or noisy transcripts, do not paste raw `/context` output into the session unless you are debugging the `/context` command itself.

Prefer this order:

1. `node scripts/workflow/session-context-audit.js --top 10`
2. a short written summary of the buckets or largest stdout blocks
3. raw `/context` output only when the exact bucket-level text is needed as evidence

This keeps session recall useful and avoids turning a context-diagnosis step into the main source of context waste.

## When To Run What

1. Start of day or resume interrupted work:
   - `bash scripts/workflow/session-start.sh --agent <claude|codex>`
   - fallback recall-only: `qctx --bootstrap`
2. Fast keyword recall (lowest latency):
   - `qctx --search-mode bm25 "<topic>"`
3. Best ranking / fuzzy recall (highest quality):
   - `qctx --search-mode hybrid "<topic>"`
4. Refresh session exports + index and commit exported markdown:
   - `bash scripts/qmd-session-sync.sh`
5. If embeddings are pending after sync:
   - `qmd-session-sync.sh` auto-runs `qmd embed` when `qmd status` reports `Pending > 0`
6. End of session handoff:
   - `qctx --close --next "<next step>" ...`
7. Concept query with different wording (semantic fallback):
   - `qmd vsearch "<concept in natural language>" -c sessions -n 10 --files`
8. Audit exported sessions to find large stdout payloads and likely compressible context:
   - `node scripts/workflow/session-context-audit.js --top 10`

## `qctx` Modes

### Bootstrap (`--bootstrap`)

- Reads latest handoff from `.claude/progress/session-handoff.jsonl`.
- Builds a query from current branch + issue + prior next step/blocker if query is omitted.
- Searches QMD sessions and prints a `Next Action` hint.
- If the primary query has no hits, retries with latest open-incident context from `.claude/progress/incident.json`.
- Defaults in this mode: `--top 5`, `--fetch 1`, `--lines 80`.
- Env overrides are available when a deeper bootstrap is explicitly needed:
  - `QCTX_BOOTSTRAP_TOP`
  - `QCTX_BOOTSTRAP_FETCH`
  - `QCTX_BOOTSTRAP_LINES`

### Session-Start Wrapper

`scripts/workflow/session-start.sh` is the canonical startup entrypoint. It runs:

1. `qctx --bootstrap`
2. `scripts/workflow/platform-loop-worktree-hygiene.sh`
3. `work-sweep.sh --agent <runtime> --fail-on-action-items`
4. `scripts/workflow/preflight.sh --skip-recall`

If `qmd status` reports pending embeddings, `session-start.sh` prints a recall-quality warning and starts background session sync by default. It also prints the log and status file paths so the main lane can keep moving while sync finishes.

The startup hygiene step is narrow:

1. prune stale `platform-loop` worktree admin entries
2. remove leftover clean `platform-loop` worktrees
3. warn and retain dirty `platform-loop` worktrees so interrupted implementation is not lost

This step does not resume implementation work. The platform pickup lane still owns creation of the fresh execution worktree and any implementation branching.

### Interactive Agent Flow

For interactive Codex/Claude runtime sessions, keep bootstrap recall in the main lane, then use this split:

1. Main lane runs `qctx --bootstrap`.
2. Main lane checks `qmd status`.
3. If `Pending > 0`, `session-start.sh` starts one background session-sync process by default.
4. Main lane continues with `work-sweep.sh` and workflow preflight immediately.
5. Background sync reports success/failure through its log/status files when it finishes.

This keeps session start independent of session sync while still repairing degraded recall in parallel.

### Standard Search (default)

- Uses explicit query, or current git branch if query omitted.
- Default `auto` mode:
  - Runs `qmd search ... -c sessions --files` (BM25 first pass).
  - If hybrid model cache is available, runs `qmd query ... -c sessions --files` and uses hybrid-ranked hits.
  - If hybrid cache is not available, keeps BM25 results and prints a warm-up hint.
- Expands top hits with `qmd get`.

### Search Modes

- `--search-mode auto` (default): BM25 first, hybrid rerank when model cache exists.
- `--search-mode bm25`: deterministic keyword ranking only, fastest.
- `--search-mode hybrid`: full `qmd query` pipeline (query expansion + rerank), best ranking, slower.

### Close (`--close`)

- Writes a structured handoff JSONL entry:
  - `timestamp`, `branch`, `issue`, `state`
  - `done`, `next_step`, `blocker`
  - `commands_run`, `files_touched`
- When `NOTION_SESSION_SUMMARY_DATABASE_ID` is set, also publishes a distilled shared summary via `scripts/workflow/notion-context.js`.
- Intended `state` values: `active`, `done`, `blocked`, `handoff`.

## Session Sync Script

`qmd-session-sync.sh` performs:

1. `claude-sessions export --today`
2. `claude-sessions codex-export --days <N>`
3. `qmd update`
4. `qmd embed` (auto, only when `qmd status` reports pending vectors)
5. `git add` export folder
6. `git commit` export changes (if any)

Example:

```bash
bash scripts/qmd-session-sync.sh --days 21
bash scripts/qmd-session-sync.sh --message "chore(sync): refresh session exports"
```

Notes:

- This script does not push.
- Push requires separate explicit git command in the export repo.

## Optional `/recall` Usage

`/recall` remains useful for temporal browsing (`today`, `yesterday`, `last week`) and quick expansion via:

```bash
python3 ~/.claude/skills/recall/scripts/recall-day.py expand <session_id>
```

For active branch/issue execution, prefer `qctx` as the primary workflow.

## Session Context Audit

Use `node scripts/workflow/session-context-audit.js` when you need to understand which exported sessions recorded the highest `/context` usage, or which transcripts were dominated by pasted command output that could likely have been summarized instead.

The audit script:

1. scans the exported session markdown files in the Obsidian session vault
2. ranks sessions with recorded `/context` snapshots by total tokens at capture time
3. measures raw `<local-command-stdout>` payload size per session
4. estimates how many stdout tokens were probably compressible if a tool had returned a short summary instead of the full payload

Helpful options:

- `--top N` to change how many sessions are shown
- `--show-blocks N` to inspect the largest stdout blocks per session
- `--json` for downstream automation or spreadsheet-style analysis

## Notes

- `qctx` is CLI-based (`qmd search` / `qmd query` + `qmd get`).
- Session recall searches the `sessions` collection, not source code.
- Graph-mode recall is not useful here because vault and project directories are separate.
- If branch-only lookup returns no hits, rerun with task keywords (symptom/component/command) instead of branch name alone.
