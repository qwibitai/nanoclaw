# Roles Classification

Role contract for NanoClaw orchestration, NanoClaw repo execution, and downstream project execution.

## Role Matrix

| Role | Runtime | Primary Scope | Must Not Do |
|------|---------|---------------|-------------|
| `you` | human operator | shape intent, priorities, and feature direction | become the hidden system of record outside Linear/Notion |
| `main` | host process control | global orchestration, group control, lane status | dispatch strict worker contracts directly to `jarvis-worker-*` |
| `andy-bot` | `nanoclaw-agent` (Claude Code lane) | observation, summarization, research, risk signal | direct worker dispatch/control |
| `andy-developer` | `nanoclaw-agent` (Claude Code lane) | coordinator, team lead, reviewer, administrator, readiness gatekeeper, task router | become the default implementation lane for scoped product work |
| `codex` | external execution lane | NanoClaw repo implementation, review/repair, bounded shaping support | self-approve vague work into `Ready` |
| `claude-code` | external execution lane | NanoClaw repo implementation, scheduled execution loops, reliability/debug execution | self-approve vague work into `Ready` |
| `jarvis-worker-*` | `nanoclaw-worker` (OpenCode lane) | bounded downstream implementation/test execution from strict dispatch contracts | own planning, governance, or NanoClaw repo implementation by default |
| `symphony` | external orchestration layer | optional orchestration for selected project-policy-approved `Ready` implementation work | act as a general planner, nightly lane, or morning prep engine |

## Routing Defaults

### NanoClaw repo

For `NanoClaw` repo work:

1. `you` shape the feature or problem
2. `andy-developer` structures the work and governs the flow
3. `codex` and `claude-code` are the default execution lanes
4. approved Symphony queues may orchestrate selected `codex` or `claude-code` work
5. `jarvis-worker-*` are not the default implementors

### Downstream project repos

For downstream project work requested through WhatsApp:

1. `you` request work
2. `andy-developer` shapes scope and readiness
3. `jarvis-worker-*` implement bounded work
4. `symphony` may orchestrate selected `Ready` issues if explicitly enabled

## Ready Ownership

`Ready` is a coordination decision.

Rules:

1. `andy-developer` is the readiness gatekeeper
2. `codex` and `claude-code` may propose or normalize issue content
3. `jarvis-worker-*` and `symphony` consume `Ready` work; they do not define it

## Handoff Sequence

### NanoClaw repo work

1. `you` define the outcome
2. `andy-developer` converts it into Notion context and/or Linear work
3. `andy-developer` approves `Ready`
4. `codex` or `claude-code` executes
5. `andy-developer` reviews, coordinates, and closes the loop

### Downstream project work

1. `you` request work through WhatsApp
2. `andy-developer` creates or updates project context and issue scope
3. `andy-developer` approves `Ready`
4. `jarvis-worker-*` or approved Symphony queue executes
5. `andy-developer` reviews and resolves to approve, rework, or escalate

## Access Policy

- `andy-developer` owns workflow governance, routing, and worker delegation authority
- `codex` and `claude-code` own NanoClaw repo execution, not workflow governance by default
- `jarvis-worker-*` focus on downstream repository implementation tasks
- `symphony` is optional and bounded to approved project issue queues
- GitHub governance changes remain `andy-developer` owned

## Related Map

For exact surface ownership and update locations, see:
`docs/operations/workflow-setup-responsibility-map.md`.
