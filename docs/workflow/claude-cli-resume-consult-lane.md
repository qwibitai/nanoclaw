# Claude CLI Resume Consult Lane

Use this workflow when Codex should consult Claude Code CLI as an additional reasoning lane, especially when prior Claude session context is valuable.

Mission anchor: `docs/MISSION.md`.

## Objective

Use Claude Code as a scoped consult/review lane while keeping Codex as primary orchestrator and executor.

## Decision Boundary

Use this lane when at least one is true:

1. Existing Claude session already contains high-value context (investigation history, architecture rationale, incident timeline).
2. Task has high ambiguity or repeated failed attempts and needs a second expert lane.
3. Reliability/security/contract review needs an independent pass.

Skip this lane when:

1. Task is simple and local context is sufficient.
2. A fresh deterministic script check is more appropriate than model reasoning.
3. Session context is stale and cannot be trusted.

## Session Strategy

Choose one mode explicitly before calling Claude:

| Mode | Command Pattern | Use When |
|------|-----------------|----------|
| Continue existing context | `claude --resume <session-id> -p "<prompt>"` | You want continuity with the same conversation history. |
| Branch from existing context | `claude --resume <session-id> --fork-session -p "<prompt>"` | You want prior context but isolated follow-up exploration. |
| Fresh consult | `claude -p "<prompt>"` | No useful prior session exists or contamination risk is high. |

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

## Anti-Patterns

1. Treating Claude consult output as a completion gate by itself.
2. Running unrestricted tools for routine analysis.
3. Mixing unrelated work into a high-value resumed session.
4. Skipping evidence capture because answer "looks right".
