 # V3 Plan: Root-Cause-First Reliability Remediation for Andy/Jarvis

  ## Summary

  This replaces the prior V2 plan by keeping the good mitigations and adding the missing root-cause tracks:

  1. Resolve intermittent Andy no output timeouts with diagnostics plus timeout separation.
  2. Explain 0 worker runs with explicit dispatch-attempt telemetry (not just run counts).
  3. Eliminate the running_without_container race path and verify no recurrence.
  4. Reduce WA reconnect churn while also proving/ disproving causal linkage to no-output failures.
  5. Keep incident open until evidence gates pass and user explicitly confirms resolution.

  ## Scope

  1. In scope:

  - andy-developer runtime stability and timeout behavior.
  - WA reconnect behavior and observability.
  - Worker run state-transition correctness.
  - Reliability/trace/hotspots script robustness.
  - Incident evidence and closure protocol.

  2. Out of scope:

  - Worker dispatch contract semantics.
  - Channel additions.
  - Architecture rewrite.

  ## Public Interfaces, APIs, and Type Changes

  1. src/config.ts and .env.example additions:

  - CONTAINER_NO_OUTPUT_TIMEOUT default 720000 (12m).
  - IDLE_TIMEOUT default 300000 (5m).
  - WA_RECONNECT_BASE_DELAY_MS default 1000.
  - WA_RECONNECT_MAX_DELAY_MS default 30000.
  - WA_RECONNECT_JITTER_MS default 750.
  - WA_RECONNECT_BURST_WINDOW_MS default 600000.
  - WA_RECONNECT_BURST_THRESHOLD default 15.
  - WA_RECONNECT_COOLDOWN_MS default 60000.

  2. src/types.ts ContainerConfig updates:

  - Add optional noOutputTimeout?: number.
  - Add optional idleTimeout?: number for per-lane override safety.

  3. scripts/jarvis-ops.sh additions:

  - New command verify-worker-connectivity.

  4. scripts/jarvis-trace.sh additions:

  - Add --until <iso> filter.
  - Add dispatch telemetry metrics:
    dispatch_payload_messages, valid_dispatch_payload_messages, dispatch_enqueued_runs,
    dispatch_suppressed_reasons.
  - Add no-output/WA correlation metric:
    no_output_events_with_wa_close_within_120s.

  ## Implementation Plan

  ## 1) Baseline Evidence Capture (before code changes)

  1. Run and archive:

  - bash scripts/jarvis-ops.sh preflight
  - bash scripts/jarvis-ops.sh reliability
  - bash scripts/jarvis-ops.sh status --window-minutes 1440
  - bash scripts/jarvis-ops.sh trace --lane andy-developer --since 2026-02-28T00:00:00+00:00 --log-lines
    20000 --json-out /tmp/andy-trace-baseline.json

  2. Capture running_without_container baseline rows from worker_runs and attach to incident notes.
  3. Keep incident status open in .claude/progress/incident.json.

  ## 2) Fix running_without_container Race (new workstream)

  1. Move updateWorkerRunStatus(runId, 'running') from pre-spawn path in src/index.ts to the container-start
     callback path in runAgent (after process registration confirms spawn).
  2. If container spawn/setup fails before callback, immediately completeWorkerRun(..., 'failed',
     reason='container_spawn_failed_before_running').
  3. Keep initial state as queued until confirmed spawn.
  4. Update stale-run reconciliation messaging to distinguish:

  - queued_stale_before_spawn
  - running_without_container

  5. Expected result: historical issue class remains visible; new runs should stop generating this race
     signature.

  ## 3) Timeout Model Separation and No-Output Diagnostics

  1. In src/container-runner.ts, split timers:

  - noOutputTimeout starts at spawn, cancels on first valid marker.
  - idleTimeout closes stdin after last output.
  - hardTimeout safety cap remains 30m minimum with idle grace.

  2. Keep current success behavior for timed out after output (idle cleanup).
  3. Emit structured timeout reason:

  - no_output_timeout
  - hard_timeout

  4. Expand timeout log metadata:

  - timeout_reason
  - configured/effective timeout values
  - chat_jid, group_folder, container_name
  - input message id range from caller context
  - last known WA connection snapshot (state, reason, reconnect attempt)

  5. Preserve cursor rollback behavior exactly as today (rollback only when no output sent).

  ## 4) Explain “0 Worker Runs” via Dispatch Telemetry (new workstream)

  1. Extend scripts/jarvis-trace.sh Python analyzer to parse Andy messages for dispatch-like payloads and
     classify:

  - invalid payload
  - blocked by policy
  - no reusable session
  - accepted and enqueued

  2. Add --until windowing for exact timeframe diagnosis.
  3. Include these counts in text and JSON output so “no worker runs” is conclusively categorized as:

  - no dispatch intent, or
  - dispatch suppression bug.

  ## 5) WA Churn Mitigation + Causality Validation

  1. In src/channels/whatsapp.ts, implement exponential backoff with jitter and burst cooldown.
  2. Track close events in an in-memory ring buffer with timestamps and reason codes.
  3. On connection=open, reset attempt counter.
  4. Add structured warning only once per cooldown window to avoid log spam.
  5. Add trace correlation logic using log events:

  - For each no_output_timeout, check WA close/reconnect events in ±120s.
  - Report correlation ratio in trace summary.

  6. Decision rule after 24h:

  - If correlation ratio >= 0.8, treat WA instability as primary trigger and prioritize WA/session hardening.
  - If correlation ratio < 0.8, prioritize prompt/model/hook-path hang diagnostics.

  ## 6) Reliability and Hotspots Script Hardening

  1. scripts/jarvis-hotspots.sh:

  - sanitize empty/non-numeric counters before Python processing.
  - guarantee deterministic exit behavior.

  2. scripts/jarvis-reliability.sh and scripts/jarvis-preflight.sh:

  - add retry wrapper (3 attempts, 1s interval) for container system status and container builder status.
  - print last stderr snippet on terminal failure.

  3. Reliability output split:

  - recent_dispatch_blocks (window-based, warning criteria)
  - all_time_dispatch_blocks (informational only)

  ## 7) Worker Connectivity Verification Gate

  1. Add scripts/jarvis-verify-worker-connectivity.sh.
  2. Gate logic:

  - run preflight and probe.
  - verify latest probe runs for jarvis-worker-1 and jarvis-worker-2 within 60m.
  - require terminal success statuses (review_requested or done).
  - require 0 stale queued/running.

  3. Return:

  - clear PASS/FAIL lines with evidence rows.
  - exit 0 on pass, 1 on fail.

  4. Wire command into scripts/jarvis-ops.sh verify-worker-connectivity.

  ## 8) Incident Closure Protocol

  1. Keep incident open until all gates below pass twice, 30+ minutes apart.
  2. Required evidence bundle:

  - status --window-minutes 180
  - trace --lane andy-developer --since <last-3h> --json-out <artifact>
  - verify-worker-connectivity
  - reliability

  3. Resolve incident only with explicit user confirmation text and recorded verification details.

  ## Test Cases and Scenarios

  ## Unit Tests

  1. src/container-runner.test.ts:

  - no_output_timeout fires before first marker.
  - first marker cancels no-output timer.
  - idle timeout after output resolves success path.
  - hard timeout reason is distinct.

  2. src/channels/whatsapp.test.ts:

  - backoff progression and jitter bound.
  - burst cooldown trigger/reset behavior.
  - reconnect counter reset on open.

  - run remains queued until spawn callback.
  ## Script Tests

  1. bash scripts/jarvis-ops.sh trace --lane andy-developer --since ... --until ... --json returns new
     metrics and correlation fields.
  2. bash scripts/jarvis-ops.sh hotspots --window-hours 24 no crash on empty windows.
  3. bash scripts/jarvis-ops.sh reliability repeated runs are stable on healthy runtime.
  4. bash scripts/jarvis-ops.sh verify-worker-connectivity deterministic pass/fail with explicit reasons.

  ## Acceptance Criteria

  1. running_without_container new occurrences: 0 for 48h post-deploy.
  2. Andy Container timed out with no output: 0 in 24h steady state, or each event has classified reason and
     correlation evidence.
  3. WA churn ratio reduced from baseline and backoff/cooldown logs show bounded reconnect behavior.
  4. trace can explicitly explain any 0 worker runs window.
  5. Connectivity gate passes twice, 30+ minutes apart.
  6. Incident remains open until user explicitly confirms fixed; then resolve with evidence.

  ## Assumptions and Defaults

  1. Worker lanes remain on-demand.
  2. No DB schema migration is required for this plan.
  3. CONTAINER_TIMEOUT stays 1800000 unless overridden per group.
  4. IDLE_TIMEOUT default moves to 300000, with per-group override available for long-running lanes.
  5. Historical running_without_container rows remain as baseline history and are not retroactively
     rewritten.

