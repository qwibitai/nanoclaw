# Subagent Routing

Central routing reference for Codex role delegation and Claude consult escalation.

## Agent Profiles

| Agent | Model | Sandbox | Mode | Primary Use |
|-------|-------|---------|------|-------------|
| `main` | `gpt-5.3-codex` `high` | session default | foreground | orchestration, user interaction, architecture, final synthesis |
| `explorer` | `gpt-5.1-codex-mini` `medium` | read-only | foreground | read-heavy discovery, docs/config lookup, first-pass logs |
| `worker` | `gpt-5.3-codex` `medium` | workspace-write | foreground | bounded implementation in approved touch-set |
| `reviewer` | `gpt-5.3-codex` `high` | read-only | foreground | regression review, contract audit, failure interpretation |
| `monitor` | `gpt-5.1-codex-mini` `low` | read-only | background by default | long-running checks, polling, watch/probe flows |
| `gpt54_escalation` | `gpt-5.4` `xhigh` | profile only | foreground | cross-system ambiguity, large-context synthesis, repeated-failure escalation |
| `claude consult` | Claude Code CLI | read-only or scoped ops | foreground | prior-context consult or independent review escalation |

## Main-Agent Boundary

Never delegate these away from the main Codex agent:

| Task | Reason |
|------|--------|
| User interaction / clarification | Requires full conversation context |
| Plan approval / prioritization | Requires mission alignment judgment |
| Architectural decisions | Requires cross-codebase judgment |
| Contract-boundary decisions | Requires orchestrator ownership |
| Cross-tool coordination (Codex/Claude) | Requires topology awareness |
| Final acceptance judgment | Must synthesize script evidence and review findings |
| Escalation decisions | Main agent decides when Codex-local paths are insufficient |
| `incident-regression` catalog role | Requires cross-codepath judgment |

## Delegation Decision Table

| Need | Agent | Mode |
|------|-------|------|
| Facts before deciding | `explorer` | foreground |
| Config/docs/log lookup | `explorer` | foreground |
| Approved plan to execute | `worker` | foreground |
| Diff review / regression scan | `reviewer` | foreground |
| Contract invariant checks | `reviewer` | foreground |
| Build/test/verify polling | `monitor` | background |
| Acceptance gate sequence | `monitor` | background |
| Probe/watch/status flows | `monitor` | background |
| Large-context ambiguity or repeated failed loops | `gpt54_escalation` | foreground |
| Prior Claude context or independent expert pass | `claude consult` | foreground |

## Delegation Payoff Gate

Before spawning any helper lane, the main agent must be able to answer "yes" to at least one of these:

1. Will this delegation materially reduce wall-clock time because the main lane has useful parallel work to do?
2. Will this delegation produce a better artifact than the main lane would produce directly right now?
3. Will this delegation isolate a long-running or noisy task that would otherwise distract the main lane?

If the answer is "no" to all three, do not delegate.

## Foreground vs Background

- Keep `explorer`, `worker`, and `reviewer` in the foreground when their output changes the next decision immediately.
- Use `monitor` in the background for long deterministic runs, polling, and log watch tasks.
- Use `reviewer` in parallel only after there is a coherent patch or stable repro to inspect.
- Allow only one write-enabled `worker` at a time.

## Skip-Delegation Rules

Do not delegate when:

- Task is faster for the main agent to complete directly
- Task requires user interaction mid-flow
- Task requires cross-agent coordination judgment
- Result is needed immediately and there is no parallel work to do locally
- The main agent cannot name the exact artifact it expects back from the delegated lane

## Anti-Patterns

| Anti-Pattern | Why |
|--------------|-----|
| Using `worker` for exploration | `worker` has write access; use `explorer` for reads |
| Using `explorer` or `monitor` for product decisions | They gather evidence; the main agent decides |
| Treating `monitor` as a debugger | `monitor` reports state; `reviewer` interprets failures |
| Running multiple write-enabled workers | Creates merge/conflict risk and unclear ownership |
| Keeping `gpt-5.4` as the default lane | Adds cost and latency without enough routine coding upside |
| Using Claude as a routine second reviewer | The default path should stay Codex-local unless escalation is justified |

## Workflow Doc Routing Index

| Workflow Doc | Agent | Mode | Main Owns | Delegates |
|---|---|---|---|---|
| `nanoclaw-jarvis-dispatch-contract.md` | `reviewer` | fg | field change decisions | contract audit + diff findings |
| `nanoclaw-jarvis-worker-runtime.md` | `explorer` | fg | runtime architecture decisions | config mapping, Dockerfile reads |
| `nanoclaw-jarvis-acceptance-checklist.md` | `monitor` | bg | pass/fail judgment | full gate sequence |
| `nanoclaw-container-debugging.md` | `explorer` -> `reviewer` | fg | root-cause triage | diagnostics first, then interpretation |
| `nanoclaw-github-control-plane.md` | `explorer` | fg | policy decisions | workflow YAML reads, drift detection |
| `nanoclaw-andy-user-happiness-gate.md` | `monitor` | bg | user satisfaction judgment | probe scripts and verification runs |
| `weekly-slop-optimization-loop.md` | `explorer` -> `monitor` | fg -> bg | prioritization | inventory first, then deterministic checks |

## Not Routed Away From Main

- `nanoclaw-development-loop.md` — is the orchestration loop
- `workflow-optimization-loop.md` — requires research judgment
- `unified-codex-claude-loop.md` — defines cross-tool coordination
- `session-recall.md` — script-driven, result is needed immediately
