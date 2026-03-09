# Claude CLI Resume Consult Lane

Use this workflow when Codex should consult Claude Code CLI as an additional reasoning lane, especially when prior Claude session context is valuable.

Mission anchor: `docs/MISSION.md`.

## Objective

Use Claude Code as a scoped consult/review lane while keeping Codex as primary orchestrator and executor.
Codex-local reasoning and subagent paths remain the default; Claude is consulted only when that path is insufficient or prior Claude context is uniquely valuable.

Primary operational use in this repository:

1. At session start, Codex runs the required GitHub collaboration sweep.
2. If `Needs My Review` surfaces a Claude-authored PR and Codex finds a review issue that is best resolved with Claude's prior implementation context, use this lane immediately from the review flow.
3. In that case, prefer the exact Claude implementation session tied to the PR over a fresh Claude session.

## Decision Boundary

Use this lane when at least one is true:

1. Existing Claude session already contains high-value context (investigation history, architecture rationale, incident timeline).
2. Task has high ambiguity or repeated failed attempts and needs a second expert lane.
3. Reliability/security/contract review needs an independent pass.
4. During session-start review work, Codex is reviewing a Claude-authored PR and the best next step is to ask that same Claude implementation session to explain, patch, or verify the reviewed code path.

Skip this lane when:

1. Task is simple and local context is sufficient.
2. A fresh deterministic script check is more appropriate than model reasoning.
3. Session context is stale and cannot be trusted.
4. Codex main + `explorer`/`reviewer`/`monitor` can still resolve the task without outside context.

## Session Strategy

Choose one mode explicitly before calling Claude:

| Mode | Command Pattern | Use When |
|------|-----------------|----------|
| Continue existing context | `claude --resume <session-id> -p "<prompt>"` | You want continuity with the same conversation history. |
| Branch from existing context | `claude --resume <session-id> --fork-session -p "<prompt>"` | You want prior context but isolated follow-up exploration. |
| Fresh consult | `claude -p "<prompt>"` | No useful prior session exists or contamination risk is high. |

Preferred default for review follow-up:

1. If Claude authored the implementation or PR under review, resume that exact implementation session first.
2. Use a fresh session only when the implementation session is unavailable, clearly stale, or corrupted.
3. If the implementation session contains useful context but needs isolation from the original branch/worktree state, resume it inside an isolated worktree rather than starting fresh.

## Permission Profiles

Default wrapper:

```bash
bash scripts/claude-consult.sh --session-id <session-id> --question "<question>"
```

Ops entrypoint equivalent:

```bash
bash scripts/jarvis-ops.sh consult --session-id <session-id> --question "<question>"
```

Never default to unrestricted execution. Pick the minimum profile first.

### Profile A: Read-only consult (default)

Use for analysis/review questions.

```bash
claude --resume <session-id> \
  --permission-mode default \
  --allowedTools "Read,Grep,Glob" \
  -p "<question>"
```

### Profile B: Scoped ops consult

Use when Claude needs limited shell checks.

```bash
claude --resume <session-id> \
  --permission-mode default \
  --allowedTools "Read,Grep,Glob,Bash(git status),Bash(git diff *)" \
  -p "<question>"
```

### Profile C: Elevated automation (exception only)

Use only in trusted isolated environments with explicit operator approval.

```bash
claude --resume <session-id> \
  --dangerously-skip-permissions \
  -p "<question>"
```

## Non-Interactive Contract

For machine-consumable output, require JSON shape and bounded execution:

```bash
claude --resume <session-id> \
  --output-format json \
  --json-schema '{"type":"object","properties":{"summary":{"type":"string"},"actions":{"type":"array","items":{"type":"string"}}},"required":["summary","actions"]}' \
  -p "<question>"
```

Recommended runtime safeguards:

1. Wrap call with timeout in automation scripts.
2. Capture stdout/stderr and exit code.
3. Fail loud on timeout or malformed JSON.
4. Do not continue downstream steps on partial output.

For implementation or review-fix follow-up where you need live visibility into Claude's behavior, prefer streaming output:

```bash
claude --resume <session-id> \
  --allowedTools "Bash,Read,Edit,Grep,Glob,Write" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  -p "<question>"
```

Use streaming mode when you need to verify whether Claude is:

1. editing code
2. running verification
3. waiting on permissions
4. drifting into side investigations

## Prompt Template

Use a strict consult prompt so output is auditable:

```text
Context:
- repo: <path>
- objective: <objective>
- constraints/invariants: <list>
- known evidence: <list>

Task:
1) Answer the question directly.
2) List risks/regressions with file-level references when applicable.
3) Provide concrete next actions.
4) If uncertain, say exactly what evidence is missing.
```

For review findings on Claude-authored code, append:

```text
Review finding:
- <exact blocking finding>

Execution constraints:
1) Continue from the current dirty state if partial edits already exist.
2) Stay in this same Claude session unless explicitly told to fork.
3) Do not use subagents unless explicitly required.
4) Keep the touch set minimal and bounded to the reviewed PR scope.
5) Run the exact required commands and report exact outcomes.
6) If you investigate a blocker, state why it is a real blocker before spending more than one focused follow-up check on it.
```

## Review-Fix Continuation Pattern

Use this when Codex finds an issue in a Claude-authored PR and wants Claude to patch it correctly with the benefit of prior context.

1. Resume the exact implementation session that produced the PR when possible.
2. Run Claude inside an isolated worktree for that PR or branch.
3. Start with a narrow prompt:
   - exact review finding
   - exact files or code path in scope
   - exact commands Claude must run
   - explicit instruction to avoid broad re-exploration
4. Enable streaming output so Codex can inspect behavior in real time.
5. If Claude appears to drift, interrupt and ask why the current line of work is needed.
6. If the reason is valid, continue in the same session.
7. If the reason is weak or side-tracking, redirect in the same session with a tighter constraint.
8. Only abandon the session and start fresh when the resumed session is clearly non-responsive, corrupted, or repeatedly ignores bounded instructions.
9. After Claude produces a satisfactory local fix, Codex remains responsible for the final review decision, commit, and push to the PR branch.

The goal is not to avoid interruption. The goal is to preserve the highest-value context while keeping Codex in control of scope and momentum.

## Integration with Unified Codex + Claude Loop

1. Use this lane during plan lock when context from prior Claude sessions materially improves decisions.
2. Use this lane during verification/review for independent risk findings.
3. Record consult outputs as evidence before acting.
4. Keep shared gates unchanged: `verify.sh`, acceptance manifests, and incident lifecycle updates still decide completion.

## Evidence and Memory Hygiene

1. Store meaningful consult outputs under `data/diagnostics/` (or work-item artifact paths).
2. Summarize adopted Claude findings into project-tracked docs/work items.
3. For non-trivial failure->fix paths, log decision trace in project-scoped memory per global contract.

## Failure Modes and Handling

1. Session ID invalid/unavailable: switch to `--fork-session` from a known-good session or run fresh consult.
2. CLI timeout/hang: abort lane, keep Codex path authoritative, and log blocker evidence.
3. Permission denial: tighten prompt or expand allowlist minimally; never jump directly to unrestricted mode.
4. Conflicting conclusions between lanes: run deterministic verification scripts and choose evidence-backed path.
5. Drift during streaming execution: interrupt, ask whether the current investigation is a real blocker, then continue in the same session if the rationale is valid.

## Anti-Patterns

1. Treating Claude consult output as a completion gate by itself.
2. Running unrestricted tools for routine analysis.
3. Mixing unrelated work into a high-value resumed session.
4. Skipping evidence capture because answer "looks right".
5. Starting a fresh Claude session for review follow-up when the implementation session is available and materially more informed.
6. Letting a streamed Claude run wander for a long period without interruption or diagnosis.
