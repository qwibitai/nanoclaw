# /codex implement — Bash ↔ Claude Marker Protocol

The orchestrator is a two-layer workflow. Bash helpers do plumbing; Claude
(the coordinating session) handles Stage 3 spec checks and attempt-4 Claude
fallbacks. The two layers synchronize through marker files in the plan's
work directory.

## Marker files

**`needs-spec-check.<wave>.<task-num>.<attempt>.json`** — bash writes when a task
reaches Stage 3. Schema:

```json
{
  "wave": 1,
  "task": 3,
  "task_body": "...",
  "plan_goal": "...",
  "plan_architecture": "...",
  "base": "origin/main",
  "worktree_path": "...",
  "diff_file": ".../diff.txt",
  "prior_attempt_findings": "",
  "requested_at": "2026-04-15T..."
}
```

`prior_attempt_findings` carries the contents of the preceding attempt's
findings file (`findings.<wave>.<task>.<attempt-1>.txt`) when `attempt > 1`,
or an empty string otherwise. It lets the spec-reviewer subagent understand
why the current diff contains changes that aren't spelled out in the literal
task spec — typically a stage-1 test failure that codex recovered from on
the next attempt. The reviewer is instructed to PASS recovery changes that
aren't in the literal spec but plausibly fix the documented prior failure.

Claude reads the marker, renders `spec-reviewer-prompt.md` with it, dispatches
a Task() subagent, writes the result to:

**`spec-check-result.<wave>.<task-num>.json`**:

```json
{
  "verdict": "PASS" | "FAIL",
  "findings_text": "...",
  "completed_at": "..."
}
```

Then Claude deletes the `needs-spec-check.*.json` file.

**`needs-claude-fallback.<wave>.<task-num>.<gen>.json`** — bash writes when
attempts 1-3 fail. `<gen>` is a per-request generation suffix
(`<pid>-<epoch>`) that keeps a stale reply from a previous run from being
consumed by a restarted attempt. Claude reads, dispatches a Claude Task()
subagent using `codex-fallback-prompt.md`, waits for completion, writes:

**`claude-fallback-result.<wave>.<task-num>.<gen>.json`** (use the same
`<gen>` suffix as the matching request marker — the standard substitution
`needs-claude-fallback` → `claude-fallback-result` preserves it):

```json
{
  "status": "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED",
  "summary": "...",
  "completed_at": "..."
}
```

## Orchestrator loop (from Claude's side)

After invoking each bash helper phase, Claude runs:

```
for f in <work-dir>/needs-spec-check.*.json; do
  dispatch Task() spec-reviewer with payload from f
  write result file
  rm f
done
for f in <work-dir>/needs-claude-fallback.*.json; do
  dispatch Task() implementer with payload from f
  write result file
  rm f
done
```

Bash helpers poll for the corresponding `*-result.json` files and proceed.
Bash uses a bounded poll: up to 15 minutes (configurable), then raises a
`BLOCKED` with reason `claude-not-responding`.

### Reference polling pattern (Claude Code `Monitor` tool)

Because Claude can't actively poll on its own — it can only act on
notifications — the coordinating session should arm a persistent Monitor
that emits when markers appear. The pattern below survived the trial run
2026-04-22 after three broken variants:

```bash
WORK="$HOME/.gstack/codex-work/<plan-slug>"
echo "[watch $(date +%H:%M:%S)] $WORK"
declare -A seen
while true; do
  sleep 5
  # find is null-safe: returns 0 with empty stdout when no matches.
  # Direct glob expansion under zsh triggers `nomatch` errexit without
  # `shopt -s nullglob` (bash) / `setopt null_glob` (zsh), so use find.
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    base=$(basename "$f")
    # Dedup by basename + mtime. Codex-gate increments the attempt
    # suffix per attempt (`.1.1.1.json`, `.1.1.2.json`, ...), but on
    # --resume the local attempt counter RESETS to 1, so the same
    # filename can be reused across resume invocations. mtime-dedup
    # catches the reused-name case.
    mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)
    key="$base@$mtime"
    if [ -z "${seen[$key]}" ]; then
      echo "[MARKER] $base (mtime=$mtime)"
      seen[$key]=1
    fi
  done < <(find "$WORK" -maxdepth 1 -name 'needs-*.json' -type f 2>/dev/null)
done 2>&1
```

Common footguns that broke earlier variants on the trial run:
- **zsh `nomatch`**: `for f in $WORK/needs-*.json` errors with exit 1 when
  nothing matches. Use `find` or prefix with `setopt null_glob`.
- **Filename-only dedup**: `needs-spec-check.1.1.1.json` is reused across
  `--resume` invocations. A name-only dedup silently drops attempts 2+
  of subsequent resumes. Always include mtime in the dedup key.
- **`grep -q` inside the loop under `set -e`**: implicit exit 1 from a
  no-match kills the monitor. Either `|| true` or switch to `case`.
- **`tail -f | grep` for marker detection**: marker files don't get
  appended to a log — they're written atomically. `tail` won't see them.
  Use `find` or `fswatch`.

When a marker notification fires, Claude's job is:

1. Read the marker payload (JSON, has `wave`, `task`, `task_body`,
   `plan_goal`, `plan_architecture`, `prior_attempt_findings`, etc).
2. Dispatch a Task() subagent with the corresponding prompt template
   (`spec-reviewer-prompt.md` or `codex-fallback-prompt.md`), rendered
   with payload fields.
3. Write the result to `<marker-basename>` with `needs-` → `spec-check-result-`
   or `claude-fallback-result-` substitution (same `<attempt>` / `<gen>` suffix).
4. `rm` the original `needs-*.json` marker.

Target response time: under 5 minutes. The bash helper times out at 15 min
per spec-check / 30 min per fallback.

## Why this split

- Bash is perfect at flock, subprocess fan-out, codex CLI invocation, git.
- Claude Task() can only be dispatched from Claude's session.
- Marker files make the boundary explicit and crash-safe — if anything dies
  mid-run, the surviving layer sees the exact state in files on disk.
