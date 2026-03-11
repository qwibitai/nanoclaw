---
description: Manual debugging wrapper for the nightly improvement lane; scheduled execution uses the headless nightly-improvement-researcher agent.
allowed-tools: Read,Grep,Glob,Bash(node scripts/workflow/nightly-improvement.js:*),Bash(git fetch:*),Bash(git log:*),Bash(git rev-list:*),Bash(git rev-parse:*),Bash(git diff-tree:*),Bash(git status)
---

Run the nightly improvement evaluation flow.

Manual-use note:

- Scheduled nightly execution does not call this slash command.
- The scheduled lane uses `scripts/workflow/start-nightly-improvement.sh`, which runs `claude -p --agent nightly-improvement-researcher`.
- Keep this command as a manual debugging wrapper only.

Requirements:

1. This lane is research-only. Never create Linear issues, mutate execution state, open PRs, or edit repo-tracked product files.
2. The only allowed runtime mutations are:
   - updating Notion shared-context pages
   - recording runtime-local cursor state through `node scripts/workflow/nightly-improvement.js record`
3. Never edit repo-tracked files, docs, or code as part of the nightly job.
4. If scratch content is needed for a shared-context page update, pass it directly to the helper over stdin instead of writing files into the repository.
5. Research only net-new source changes. If the helper says a source/version was already evaluated, skip it unless explicitly forced.
6. Keep token usage low:
   - use the helper scan output as the primary source of truth
   - do not fetch extra docs unless a candidate still looks promising after the scan output
   - stop after the bounded worklist in the scan output is handled
7. Maintain exactly one upstream shared-context page and one tooling shared-context page. Update existing pages instead of creating floods.
8. Every decision update must use:
   - `Agent Label: Claude Code`
   - `Decision: pilot|defer|reject`
   - `To: Codex`
   - `Status: needs-input`
   - `Next: morning Codex triage`

Execution flow:

1. Run `node scripts/workflow/nightly-improvement.js scan --output /tmp/nightly-improvement-scan.json`.
2. Read `/tmp/nightly-improvement-scan.json`.
3. If the scan result is `{ "action": "noop" }`:
   - run `node scripts/workflow/nightly-improvement.js record --scan-file /tmp/nightly-improvement-scan.json`
   - summarize the skip reason in one sentence and stop
4. If `upstream.pending` is true:
   - use the scan output as the default evidence set
   - fetch extra upstream docs only when a specific commit summary still looks promising
   - pipe a concise structured update that begins with `<!-- nightly-improvement:upstream -->` into:
     `node scripts/workflow/nightly-improvement.js upsert-context --kind upstream --body-stdin`
   - include: evaluated range, changed commits, subsystem fit, candidate adoption or `no-fit`, risk/operator-load note, and `P1/P2/P3`
   - run `node scripts/workflow/nightly-improvement.js append-decision --kind upstream --decision <pilot|defer|reject> --summary "<one-line summary>" --agent-label "Claude Code" --to codex --status needs-input --next "morning Codex triage"`
5. If tooling candidates are present:
   - evaluate only the listed changed tools from the scan output
   - fetch extra implementation docs only for candidates that still look relevant
   - pipe a concise structured update that begins with `<!-- nightly-improvement:tooling -->` into:
     `node scripts/workflow/nightly-improvement.js upsert-context --kind tooling --body-stdin`
   - include: version deltas, source links used, subsystem fit, candidate adoption or `no-fit`, risk/operator-load note, and `P1/P2/P3`
   - run `node scripts/workflow/nightly-improvement.js append-decision --kind tooling --decision <pilot|defer|reject> --summary "<one-line summary>" --agent-label "Claude Code" --to codex --status needs-input --next "morning Codex triage"`
7. After the relevant context updates succeed, run:
   - `node scripts/workflow/nightly-improvement.js record --scan-file /tmp/nightly-improvement-scan.json`
6. End with a short summary covering:
   - whether upstream changed
   - which tools changed
   - which shared-context pages were created or updated
   - anything intentionally skipped for token efficiency

Efficiency rules:

- Do not re-research an upstream head or tool version that is already recorded in the nightly state unless explicitly forced.
- Do not fetch extra docs for unchanged sources.
- Do not turn one changed release into many shared-context pages.
- If the scan lists deferred tooling candidates because the nightly cap was reached, note that fact in the tooling page and stop instead of expanding the research budget.
