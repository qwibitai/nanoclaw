# Session Recall Workflow

Reconstruct actionable session context quickly and reliably.

This workflow now uses two separate scripts:

1. `qmd-context-recall.sh` for recall only (search + handoff).
2. `qmd-session-sync.sh` for session export sync + `git add` + `git commit`.

## Quick Commands

```bash
# Session start (recommended)
qctx --bootstrap

# Session start with explicit issue
qctx --bootstrap --issue INC-123

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
```

If `qctx` alias is not installed, use:

```bash
bash scripts/qmd-context-recall.sh --bootstrap
```

## Recommended Workflow

1. Session start: run `qctx --bootstrap`.
2. During work: run `qctx "<topic>"` before major debug/fix loops.
3. If query precision matters, rerun with `qctx --search-mode hybrid "<topic>"`.
4. If recall seems stale, run `bash scripts/qmd-session-sync.sh` and rerun recall.
5. Session end: run `qctx --close ...` with concrete `--next`.

## When To Run What

1. Start of day or resume interrupted work:
   - `qctx --bootstrap`
2. Fast keyword recall (lowest latency):
   - `qctx --search-mode bm25 "<topic>"`
3. Best ranking / fuzzy recall (highest quality):
   - `qctx --search-mode hybrid "<topic>"`
4. Refresh session exports + index and commit exported markdown:
   - `bash scripts/qmd-session-sync.sh`
5. Embeddings backlog exists (`qmd status` shows `Pending > 0`):
   - `qmd embed`
6. End of session handoff:
   - `qctx --close --next "<next step>" ...`
7. Concept query with different wording (semantic fallback):
   - `qmd vsearch "<concept in natural language>" -c sessions -n 10 --files`

## `qctx` Modes

### Bootstrap (`--bootstrap`)

- Reads latest handoff from `.claude/progress/session-handoff.jsonl`.
- Builds a query from current branch + issue + prior next step/blocker if query is omitted.
- Searches QMD sessions and prints a `Next Action` hint.
- If the primary query has no hits, retries with latest open-incident context from `.claude/progress/incident.json`.
- Defaults in this mode: `--top 10`, `--fetch 3`.

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
- Intended `state` values: `active`, `done`, `blocked`, `handoff`.

## Session Sync Script

`qmd-session-sync.sh` performs:

1. `claude-sessions export --today`
2. `claude-sessions codex-export --days <N>`
3. `qmd update`
4. `git add` export folder
5. `git commit` export changes (if any)

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

## Notes

- `qctx` is CLI-based (`qmd search` / `qmd query` + `qmd get`).
- Session recall searches the `sessions` collection, not source code.
- Graph-mode recall is not useful here because vault and project directories are separate.
- If branch-only lookup returns no hits, rerun with task keywords (symptom/component/command) instead of branch name alone.
