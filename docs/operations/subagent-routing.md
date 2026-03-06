# Subagent Routing

Central routing reference for model-tiered agent delegation.

## Agent Profiles

| Agent | Model | Tools | Mode | Memory | Cost Tier |
|-------|-------|-------|------|--------|-----------|
| `scout` | haiku | Read, Grep, Glob, Bash, WebSearch, WebFetch | foreground | project | ~$0.25/1M |
| `implementer` | sonnet | Read, Edit, Write, Bash, Grep, Glob | foreground | none | ~$3/1M |
| `verifier` | haiku | Bash, Read, Grep, Glob | foreground or background | project | ~$0.25/1M |

## Opus-Only Boundary

Never delegate these to subagents:

| Task | Reason |
|------|--------|
| Architectural decisions | Requires cross-codebase judgment |
| Incident root-cause triage | Requires reasoning across symptoms |
| User interaction / clarification | Requires conversation context |
| Plan approval / prioritization | Requires mission alignment judgment |
| Cross-tool coordination (Claude/Codex) | Requires orchestration context |
| Research evaluation / scoring | Requires domain expertise |
| `incident-regression` catalog role | Requires cross-codepath judgment |

## Delegation Decision Table

| Need | Agent | Mode |
|------|-------|------|
| Facts before deciding | `scout` | foreground |
| Approved plan to execute | `implementer` | foreground |
| Build/test/lint gates | `verifier` | background (long) or foreground (quick) |
| Config/Dockerfile reads | `scout` | foreground |
| Contract invariant checks | `verifier` | foreground |
| Documentation sync scan | `scout` | foreground |
| Acceptance gate sequence | `verifier` | background |
| Probe scripts | `verifier` | background |

## Skip-Delegation Rules

Do not delegate when:

- Task is < 2 minutes for Opus directly
- Task requires user interaction mid-flow
- Task requires cross-agent coordination judgment
- Result is needed immediately with no parallel work

## Anti-Patterns

| Anti-Pattern | Why |
|--------------|-----|
| Re-verifying verifier output | Verifier returns exit codes; trust them |
| Using implementer for exploration | Implementer has write tools; use scout for reads |
| Scout for writing files | Scout is read-only by design |
| Delegating without a plan to implementer | Implementer needs explicit instructions |
| Running verifier foreground when you could parallel | Use background for long gates |

## Workflow Doc Routing Index

| Workflow Doc | Agent | Mode | Opus Owns | Delegates |
|---|---|---|---|---|
| `nanoclaw-jarvis-dispatch-contract.md` | verifier | fg | field change decisions | build + test + contract lint |
| `nanoclaw-jarvis-worker-runtime.md` | scout | fg | runtime architecture decisions | config mapping, Dockerfile reads |
| `nanoclaw-jarvis-acceptance-checklist.md` | verifier | bg | pass/fail judgment | full gate sequence |
| `nanoclaw-container-debugging.md` | scout | fg | root-cause triage | diagnostics, log grep |
| `nanoclaw-github-control-plane.md` | scout | fg | policy decisions | workflow YAML reads, drift detection |
| `nanoclaw-andy-user-happiness-gate.md` | verifier | bg | user satisfaction judgment | probe scripts |
| `weekly-slop-optimization-loop.md` | scout→verifier | fg→bg | prioritization | inventory scripts, then verification gates |

## NOT Routed (Opus-Only)

- `nanoclaw-development-loop.md` — IS the orchestration loop
- `workflow-optimization-loop.md` — requires research judgment
- `unified-codex-claude-loop.md` — cross-tool coordination
- `session-recall.md` — script-driven, Opus needs result immediately
