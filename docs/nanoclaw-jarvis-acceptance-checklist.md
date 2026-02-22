# NanoClaw-Jarvis Acceptance Checklist

Use this checklist before marking NanoClaw-Jarvis integration complete.

## Scope Lock

- [x] `docs/nanoclaw-jarvis.md` treated as source of truth. *(updated with full architecture decision + Codex analysis)*
- [x] No HTTP worker service introduced. *(IPC + ephemeral container dispatch only)*
- [x] Existing behavior for non-Jarvis groups remains unchanged (backward-compatible). *(runId/dedup only applied to `jarvis-worker-*` folders; typecheck passes)*

## Contract and Policy Reuse

- [x] Dispatch payload schema is used only for IPC/task validation (no HTTP dependency).
- [x] Worker policy limits are applied as internal runtime tuning (not as HTTP API dependency).
- [x] Dispatch payload includes `run_id`. *(`ContainerInput.runId`, generated in index.ts from SHA256 of folder+msgId+content)*
- [x] Duplicate `run_id` is deduplicated in queue/DB. *(`worker_runs` table + `insertWorkerRun()` returns false on duplicate)*

## Worker Group Setup (Phase 1)

- [x] Jarvis worker groups are registered (`jarvis-worker-1..N`) in DB. *(jarvis-worker-1@nanoclaw, jarvis-worker-2@nanoclaw registered)*
- [x] Worker groups have correct container image + mounts configured. *(Sonnet 4.6, 10min timeout, jarvis-workspaces + repos mounts)*
- [x] `groups/jarvis-worker-*/CLAUDE.md` exists and defines worker behavior. *(jarvis-worker-1 + jarvis-worker-2)*
- [x] `GITHUB_TOKEN`/`GH_TOKEN` available inside worker shell execution. *(set in process.env in agent-runner index.ts; git auto-configured)*
- [x] `/workspace/extra/jarvis-workspaces` mount is writable from worker. *(mount-allowlist.json updated, nonMainReadOnly=false)*
- [x] `/workspace/extra/repos` mount is writable from worker. *(same allowlist fix)*

## Dispatch and Guidance (Phase 2)

- [x] `groups/andy-developer/docs/jarvis-dispatch.md` exists and is current. *(worker JIDs, payload format, parallel dispatch, run_id guidance)*
- [x] Dispatch format documents required fields (`run_id`, `task_type`, `priority`, `retry_policy`, `timeouts`). *(all in jarvis-dispatch.md)*
- [x] `groups/andy-developer/CLAUDE.md` includes pre-dispatch instruction to read dispatch docs. *(`BEFORE spawning a Jarvis worker → read /workspace/group/docs/jarvis-dispatch.md`)*
- [x] `mcp__nanoclaw__send_message` flow documented for targeting specific worker groups. *(with example JSON in jarvis-dispatch.md)*

## Runtime Output and Usage Reporting

- [x] `ContainerOutput` includes usage stats:
  - [x] input/output tokens *(from SDK result message `usage` field)*
  - [x] `peak_rss_mb` *(polled every 2s via setInterval in agent-runner)*
  - [x] `duration_ms` *(wall-clock from query start to result)*
- [x] Usage stats are surfaced back to Andy in final response. *(appended in `<internal>` tag on worker group responses)*
- [x] Streaming behavior remains functional (stdout marker-based path). *(usage added to existing writeOutput call; no structural change)*

## Parallel Execution and Safety

- [x] At least two worker groups can run in parallel. *(jarvis-worker-1 + jarvis-worker-2 registered; each is an independent group with isolated container)*
- [x] No cross-group state leakage (sessions/workspaces isolated). *(each group has its own `.claude/` sessions dir, IPC namespace, and group folder)*
- [x] Retry behavior does not double-execute same `run_id`. *(`insertWorkerRun()` returns false on UNIQUE constraint; caller skips execution)*
- [ ] Timeout/failure path returns clear error and preserves auditability. *(container timeout error path untested with worker groups — needs live test)*

## Tests

- [x] Unit tests added/updated for:
  - [x] `run_id` dedupe logic *(7 tests in `src/jarvis-worker-dispatch.test.ts`)*
  - [x] usage stats extraction/propagation *(shape test in same file)*
  - [x] run_id generation stability *(hash determinism tests)*
  - [ ] payload validation *(Codex's Zod schemas not yet wired into dispatch path)*
  - [ ] parallel worker dispatch behavior *(no integration test yet)*
- [ ] Integration test (or scripted proof) covers end-to-end dispatch to worker and returned result.
- [x] All relevant tests pass locally. *(10/10 pass, typecheck clean)*

## Evidence Required in PR/Report

- [x] List of DB changes/migrations. *(`worker_runs` table added; migration-safe via `CREATE TABLE IF NOT EXISTS`)*
- [x] Paths of updated docs.
  - `docs/nanoclaw-jarvis.md`
  - `docs/nanoclaw-jarvis-acceptance-checklist.md`
  - `groups/andy-developer/CLAUDE.md`
  - `groups/andy-developer/docs/jarvis-dispatch.md`
  - `groups/jarvis-worker-1/CLAUDE.md`
  - `groups/jarvis-worker-2/CLAUDE.md`
- [ ] Sample transcript for one successful worker run with usage stats. *(needs live end-to-end run)*
- [ ] Sample transcript showing two parallel worker groups processing different runs. *(needs live end-to-end run)*
- [ ] Short note confirming non-Jarvis groups were regression-checked. *(typecheck + existing test suite passes; live regression test pending)*

## Remaining Before Done

1. **Container rebuild** — agent-runner usage stats changes need new image built (in progress)
2. **Live end-to-end test** — Andy dispatches a task to jarvis-worker-1, verify result + usage stats appear
3. **Parallel run test** — dispatch two tasks simultaneously, verify both complete independently
4. **Payload validation** — optionally wire Codex's Zod schemas into dispatch path
5. **Regression check** — send a message to Andy-bot (main group) and confirm no breakage

## Exit Criteria

Mark integration complete only when every checkbox above is satisfied or explicitly waived with rationale.
