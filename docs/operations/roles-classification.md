# Roles Classification

Role contract for NanoClaw + Jarvis operation.

## Role Matrix

| Role | Runtime | Primary Scope | Must Not Do |
|------|---------|---------------|-------------|
| `main` | host process control | global orchestration, full group control | n/a |
| `andy-bot` | `nanoclaw-agent` (Claude Code lane) | observation, summarization, GitHub research on `openclaw-gurusharan`, risk triage | direct worker dispatch/control |
| `andy-developer` | `nanoclaw-agent` (Claude Code lane) | strict worker dispatch, review/rework loop, GitHub control-plane administration | bypass contract or dispatch to non-worker lanes |
| `jarvis-worker-*` | `nanoclaw-worker` (OpenCode lane) | bounded implementation/test execution from dispatch contract, produce `<completion>` payload | unbounded orchestration decisions or control-plane governance |

## Handoff Sequence

1. `andy-bot` gathers context and risk signal.
2. `andy-developer` emits strict JSON dispatch (`run_id`, branch, tests, output contract).
3. `jarvis-worker-*` executes and returns `<completion>`.
4. `andy-developer` reviews and resolves to approve/rework.
5. For user QA requests, `andy-developer` stages (or clones if missing) the approved branch/commit in `NanoClawWorkspace`, runs local preflight (`build` + `server start/health`) on that same branch/commit, verifies no duplicate same-lane running containers, then provides user-run local testing commands.

For UI-impacting changes, browser verification is default:
- `andy-developer` dispatches WebMCP-required acceptance checks unless fallback is explicitly approved.
- `jarvis-worker-*` must return WebMCP evidence (`modelContextTesting.listTools()` and task-relevant `executeTool()` output) before approval is eligible.

## Access Policy

- `andy-bot` and `andy-developer` both retain GitHub access (`GITHUB_TOKEN`/`GH_TOKEN`) for `openclaw-gurusharan` activity.
- Only `andy-developer` has worker delegation authority in IPC lanes.
- `andy-developer` owns GitHub workflow/review governance changes; workers focus on repository implementation tasks.
- `andy-developer` decides whether `@claude` review is required, optional, or disabled per project requirement profile.
- Local review handoff checks are default behavior for `andy-developer` when declaring "ready for user review" (not reminder-driven).

## Skill Source Of Truth

- `container/skills/testing` is a symlink to `~/.claude/skills/testing`.
- `container/skills/browser-testing` is a symlink to `~/.claude/skills/browser-testing`.
- Update WebMCP testing behavior in those global `SKILL.md` targets so Andy and Jarvis lanes receive the same policy.
- `container/skills/agent-browser/SKILL.md` remains local in-repo and is not part of the global testing/browser-testing sync path.

## Related Map

For workflow setup selection and exact update locations, see:
`docs/operations/workflow-setup-responsibility-map.md`.
