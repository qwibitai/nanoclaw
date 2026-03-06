# NanoClaw Container Debugging Workflow

Canonical runtime-debug workflow for NanoClaw (Apple Container first).

Use this before ad-hoc debugging when container/auth/session/mount/runtime behavior fails.

## Rule

1. Prefer scripted diagnostics first (`scripts/jarvis-ops.sh`).
2. Use `container` CLI as default runtime interface.
3. Use Docker commands only as legacy fallback when explicitly running Docker.

## Quick Diagnostic (Run First)

```bash
bash scripts/jarvis-ops.sh preflight
bash scripts/jarvis-ops.sh status
bash scripts/jarvis-ops.sh reliability
```

If any command fails, capture exact output and continue via issue category below.

## Issue Categories

| Symptom | Primary Path |
|---------|--------------|
| Runtime not responding, CLI hangs, container state mismatch | Runtime health + recovery |
| Worker dispatch/probe failures | Connectivity + trace path |
| Auth/session failures | Auth + session path |
| Mount/permission/config failures | Mount + config path |
| MCP failures | MCP reliability loop |

## 1) Runtime Health + Recovery

```bash
container system status
container builder status
container ls -a
```

If runtime is unhealthy or commands hang:

```bash
bash scripts/jarvis-ops.sh recover
bash scripts/jarvis-ops.sh preflight
bash scripts/jarvis-ops.sh status
```

After recovery, inspect current-runtime evidence before deciding restart regressions still reproduce:

```bash
tail -n 500 logs/nanoclaw.log
```

Interpretation rule:

- Old `ERR_FS_CP_EINVAL` or `No channel for JID` lines elsewhere in the historical log are not enough to reopen the incident.
- Require a fresh post-restart occurrence or a current PID-scoped log hit.

## 2) Worker Connectivity + Dispatch Failures

```bash
bash scripts/jarvis-ops.sh verify-worker-connectivity
bash scripts/jarvis-ops.sh linkage-audit
bash scripts/jarvis-ops.sh trace --lane andy-developer
bash scripts/jarvis-ops.sh dispatch-lint --file /tmp/dispatch.json --target-folder jarvis-worker-1
```

If the app is a customized fork using internal worker JIDs (`jarvis-worker-*@nanoclaw`):

- Treat `No channel for JID: jarvis-worker-*@nanoclaw` as a root-runtime synthetic-dispatch regression, not a WhatsApp group-registration problem.
- Check the canonical root runtime first (`src/index.ts`, `src/ipc.ts`) rather than assuming the worker-copy runtime is active.
- Re-run `verify-worker-connectivity` and confirm fresh `probe-*` `worker_runs` reach `review_requested`.

If the issue involves Andy follow-up dispatches:

- A validator block for `context_intent=continue` without a reusable session is expected behavior.
- The blocked request must transition terminal (`failed`) with reason text; only the retry request should remain active.
- `bash scripts/jarvis-ops.sh linkage-audit` must pass after the full user journey.

If connectivity remains unstable, capture evidence bundle:

```bash
bash scripts/jarvis-ops.sh incident-bundle --window-minutes 180 --lane andy-developer
```

## 3) Auth + Session Path

Check auth/quota state without printing secrets:

```bash
bash scripts/jarvis-ops.sh auth-health
bash scripts/jarvis-ops.sh preflight
```

Check session continuity symptoms:

```bash
grep -E "Session initialized|resume" logs/nanoclaw.log | tail -20
```

If needed, use targeted session checks from `docs/troubleshooting/DEBUG_CHECKLIST.md`.

## 4) Mount + Permission + Runtime Config Path

Inspect mount and runtime artifacts:

```bash
grep -E 'Mount validated|Mount.*REJECTED|mount' logs/nanoclaw.log | tail -20
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"
```

Validate role/runtime placement rules before editing runtime:

- `docs/operations/runtime-vs-prebaked-boundary.md`
- `docs/workflow/nanoclaw-jarvis-worker-runtime.md`

## 5) MCP Failures

Follow fix-first loop:

1. Capture exact MCP tool failure.
2. Fix MCP server/config at source.
3. Re-run minimal MCP verification.
4. Fall back only with blocker evidence.

Reference: `docs/workflow/skill-routing-preflight.md` (MCP Reliability Loop).

## Log Locations

| Log | Path |
|-----|------|
| Main app | `logs/nanoclaw.log` |
| Main errors | `logs/nanoclaw.error.log` |
| Container runs | `groups/{folder}/logs/container-*.log` |

## Deterministic Debug Exit Criteria

A debug run is complete only when:

1. Failing symptom is reproduced and explained with root cause.
2. Relevant scripted checks pass (`preflight`, `status`, plus lane-specific checks).
3. For Andy/Jarvis dispatch issues, `verify-worker-connectivity` and `linkage-audit` both pass.
4. Evidence is captured (trace/bundle) for handoff.
5. Incident state is updated if issue is non-trivial.

## Legacy Docker Appendix (Fallback Only)

Use only if runtime is intentionally Docker-based:

```bash
docker info
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'
```

Do not use Docker commands as the default NanoClaw runtime debug path.

## Agent Routing

| Step | Agent | Mode | Notes |
|------|-------|------|-------|
| Root-cause triage | opus | — | Requires cross-symptom reasoning |
| Diagnostics | scout | fg | `container system status`, `container ls -a` |
| Log grep | scout | fg | Search daemon/container logs for error patterns |
| Health checks | verifier | fg | Port listening, process status exit codes |
