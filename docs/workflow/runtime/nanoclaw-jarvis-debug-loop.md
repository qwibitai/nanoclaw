# NanoClaw Jarvis Debug Loop

Use this loop when worker builds hang, delegation fails, or smoke flow breaks.

## Role Model (Mandatory)

- `Andy-bot`: observe, summarize, triage risk, GitHub research on `openclaw-gurusharan`, hand off.
- `Andy-developer`: dispatch/review owner for Jarvis workers.
- `jarvis-worker-*`: bounded execution only.

If the issue is execution-path related, debug through `andy-developer -> jarvis-worker-*`, not direct worker-only assumptions.

## Mission Debugging Priorities

Use debugging modes that expose root cause quickly and deterministically.

### High-Signal Debugging (Use)

1. `bash scripts/jarvis-ops.sh trace --lane andy-developer` to get timeline + root-cause markers.
2. `bash scripts/jarvis-ops.sh incident-bundle --window-minutes 180 --lane andy-developer` to capture repeatable evidence.
3. DB/source-of-truth checks (`andy_requests`, `worker_runs`, `dispatch-block` artifacts) before chat-text interpretation.
4. E2E repro scripts (`scripts/test-andy-full-user-journey-e2e.ts`, `scripts/test-andy-user-e2e.ts`) to validate user-facing behavior and linkage.
5. Deterministic validation reruns after fix (`verify-worker-connectivity`, `linkage-audit`, acceptance gate, happiness gate when user-facing).

### Low-Signal Debugging (Avoid)

1. Probe-only loops (`probe` + waiting) without trace/artifact/DB correlation.
2. Declaring success from `reliability` pass/warn summaries alone.
3. Parsing conversational ack text as primary truth when DB linkage fields exist.
4. Treating sandbox permission artifacts as production runtime failures without out-of-sandbox confirmation.
5. Grepping the entire historical log after restart and treating old failures as current-runtime regressions.

## Root Cause -> Exact Fix Patterns

| Symptom Pattern | Root Cause | Fix Pattern | Verify |
|----------------|------------|-------------|--------|
| Dispatch blocked (`invalid dispatch payload`) and request remains `coordinator_active` without `worker_run_id` | Coordinator dispatched without required linkage field(s) | Inject required linkage field(s) at dispatch composition time; align dispatch docs + lint + tests with runtime contract | Full-user-journey E2E shows `request_id -> worker_run_id` linkage and no new dispatch-block artifacts |
| `No channel for JID: jarvis-worker-*@nanoclaw` during probe or Andy->worker dispatch | Root runtime lost the fork-specific internal synthetic-worker send path and tried to route worker JIDs like external channels | Restore root `src/index.ts` + `src/ipc.ts` internal `@nanoclaw` dispatch handling; verify worker lanes are processed as synthetic internal groups | `verify-worker-connectivity` creates fresh `probe-*` rows and both lanes reach `review_requested` |
| `Dispatch blocked by validator` with `context_intent=continue requires a reusable prior session...` and the original request stays `coordinator_active` | Follow-up dispatch had no reusable session and the blocked request was not transitioned terminal | Keep validator block, but mark blocked request `failed` with reason text so only the retry request remains active | Full-user-journey E2E shows blocked first attempt, linked retry request, and `linkage-audit` PASS with no stale unlinked active requests |
| `verify-worker-connectivity` false-negative in transient runtime windows | Preflight signal too coarse/noisy | Split preflight behavior into deterministic checks with explicit failure detail and permission-context hints | `verify-worker-connectivity` PASS with preflight PASS; no recurrence in incident notes |
| `failed_contract` from stale/duplicate completion blocks | Completion parser chooses wrong block | Parse and validate latest valid `<completion>` block and add regression test | Focused probe transitions to `review_requested` for both worker lanes |
| Acceptance/connectivity gate fails on shell portability (`mapfile`/bash3 mismatch) | Script relies on non-portable shell features | Replace with bash3-safe `while read` patterns and retest gates | Acceptance gate PASS + connectivity PASS across runtime environment |

## Mission Default Debugging Loop

1. Run incident-bundle + trace first (`preflight`, `status`, `reliability`, `db-doctor`, `hotspots`, `trace`).
2. Extract concrete blocker artifacts (`dispatch-block-*`, failed run rows, or trace reason markers).
3. Reproduce with full E2E + DB assertions, not chat-text assumptions.
4. Patch the exact failing layer (`contract`, `composer`, `validator`, `parser`, or portability path).
5. Re-verify with deterministic gates (`verify-worker-connectivity`, `linkage-audit`, happiness gate when user-facing, acceptance gate).

## 1) Container Runtime Health

Run in order:

1. `container system status`
2. `container builder status`
3. `container ls -a`

If CLI commands hang:

1. kill stuck `container ...` CLI processes
2. `container system stop`
3. `container system start`
4. `container builder start`

If logs show `ERR_FS_CP_EINVAL` with `src and dest cannot be the same` under `.claude/skills`:

1. confirm runtime is on latest `src/container-runner.ts`
2. verify skill staging skips hidden entries (like `.docs`)
3. restart NanoClaw service after build (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`)
4. scope log review to the current runtime PID or a post-restart tail before deciding the issue still reproduces

## 2) Worker Build Failures

If buildkit DNS fails (`EAI_AGAIN`, `Temporary failure resolving`):

- Do not rely on apt/npm inside buildkit.
- Use `container/worker/build.sh` artifact flow:
  - prepare OpenCode bundle with `container run`
  - build with local `vendor/opencode-ai-node_modules.tgz`

Validation:

1. `./container/worker/build.sh`
2. `container images | rg nanoclaw-worker`

## 3) OpenCode Runtime Failures

If worker output indicates model issues:

- Check for `Model not found` in worker output.
- Ensure runner fallback path remains active:
  1. requested model
  2. `opencode/minimax-m2.5-free`
  3. `opencode/big-pickle`
  4. `opencode/kimi-k2.5-free`

If output is JSON event stream:

- parse `text` events (and `message.part.updated` text fields), not only final `step_finish`.

## 4) Delegation Authorization Checks

Expected IPC behavior:

- `main` -> any group: allowed.
- `andy-developer` -> `jarvis-worker-*`: allowed.
- non-main/non-Andy groups -> cross-group: blocked.

If delegation fails, verify `src/ipc.ts` authorization gates first.

## 5) End-to-End Smoke Gate

Run:

`npx tsx scripts/test-worker-e2e.ts`

Pass criteria:

1. Andy container uses `nanoclaw-agent:latest`
2. Worker container uses `nanoclaw-worker:latest`
3. Dispatch validates
4. Completion validates
5. `worker_runs.status == review_requested`

If fail:

- capture failing stage
- apply fix
- rerun smoke until green
- update docs/checklist evidence

## 6) Quota-Limited Claude Lane

If `andy-developer` or `main` returns quota text (`You've hit your limit ...`):

1. treat as model-capacity issue, not dispatch/runtime failure
2. keep worker path available for bounded execution tasks
3. retry after quota reset or adjust model/runtime for affected group
