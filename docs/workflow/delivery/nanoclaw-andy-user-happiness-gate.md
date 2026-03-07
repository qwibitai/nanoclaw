# NanoClaw Andy User Happiness Gate

Release gate for `andy-developer` and main-lane control-plane user-facing behavior.

This gate is intentionally user-centric:

1. The response must arrive fast enough to feel immediate.
2. The response content must directly answer the user.
3. Internal state handling must remain correct and stable.
4. The user should not need to remember internal IDs to get useful status.

## When To Run

Run before declaring any Andy/Jarvis reliability fix complete, and before any bloat-strip phase.

## Pass Criteria

### 1) User Perceived Latency

- Greeting (`hi`-style) response within `<= 8s`
- Progress query response within `<= 8s`
- Natural status query (no internal IDs) response within `<= 8s`
- Main-lane `andy-developer` status query feels immediate enough to be useful

### 2) User Response Quality

- Replies are direct and actionable (not generic filler).
- Progress/status replies include concrete state details (what is running now, what just finished, what is queued next).
- Replies do not contain stack traces, raw exceptions, or generic internal error dumps.
- Default status questions should work without `req-*` IDs.
- Main lane must not answer `andy-developer` status questions with “I don't have direct visibility” style fallback text when control-plane status is available.

### 3) Internal Correctness

- Status/greeting probes do not trigger unintended worker dispatches.
- Status/greeting probes do not create `andy_requests` intake rows.
- Natural status phrasing such as `@Andy what are you working on right now?` must be classified as status, not work intake.
- If a follow-up dispatch is validator-blocked (for example `context_intent=continue` without reusable session), the blocked request must not remain `coordinator_active`.
- Probe window must not introduce `running_without_container` regression failures.

### 4) Human Satisfaction Check (Required)

- Operator confirms: "As a user, I am satisfied with what I got, when I got it, and how the system behaved."
- Tester uses judgment as a real user, not only regex/test-pass output.

## Workflow

1. Run the consolidated gate command:
   - `bash scripts/jarvis-ops.sh happiness-gate --user-confirmation "<manual User POV runbook completed>"`
2. If probe fails, do not proceed to strip-down.
3. Fix issue, rerun probe, and only continue when all checks pass.
4. Add or update incident note with probe evidence before closing incident.

## User QA Handoff Gate

When work is marked ready for user testing:

1. Andy reviews worker completion and explicitly approves branch/commit.
2. Andy syncs the approved branch/commit into `NanoClawWorkspace` or the active local test workspace.
3. Andy runs local preflight on that same branch/commit and records outcomes.
4. Andy verifies there are no duplicate same-lane running containers before handoff.
5. Andy confirms the preflight was executed on the exact branch/commit being handed off.
6. Andy sends the user handoff block with repo path, branch/commit, and local startup/health/stop commands.

If preflight fails or lane state is inconsistent, do not mark the work ready for user testing.

## User POV Runbook (Required)

Run this manual sequence at least once per release candidate:

1. Send a normal development request to `andy-developer` (for example: "build a small app and add feature X").
2. While work is in progress, ask naturally: "what are you working on right now?"
3. Ask another follow-up naturally: "what is the current progress?"
4. In the main lane, ask naturally about `andy-developer` status (for example: "Do you have a view of Andy developer and its status?").
5. Confirm replies are immediate, specific, and understandable without `req-*` or internal IDs.
6. Confirm answer quality feels human-helpful, not robotic boilerplate.

This runbook is a hard requirement in addition to script checks.
The `--user-confirmation` value in the gate command must explicitly confirm this runbook was completed.

Equivalent expanded form (for debugging):

- `bash scripts/jarvis-ops.sh status`
- `bash scripts/jarvis-ops.sh verify-worker-connectivity`
- `bash scripts/jarvis-ops.sh linkage-audit`
- `node --experimental-transform-types scripts/test-andy-user-e2e.ts`
- `node --experimental-transform-types scripts/test-main-lane-status-e2e.ts`
- `node --experimental-transform-types scripts/test-andy-full-user-journey-e2e.ts` when the fix touches dispatch/linkage/runtime behavior

## Probe Script

`scripts/test-andy-user-e2e.ts` validates:

- `@Andy hi` reply quality + latency
- `@Andy what are you working on right now?` reply quality + latency
- `@Andy what is the current progress` reply quality + latency
- Internal guardrails for request/worker side effects
- Baseline user-facing quality for no-ID status probing

`scripts/test-main-lane-status-e2e.ts` validates:

- Natural-language main-lane questions about `andy-developer` status/progress
- Concrete control-plane status details in the reply
- No fallback to generic “no visibility” language when status is available

When the change touches Andy->worker dispatch, also require:

- `scripts/test-andy-full-user-journey-e2e.ts` PASS
- `bash scripts/jarvis-ops.sh linkage-audit` PASS after the journey completes

## Fail Handling

Treat any failure as blocking for release:

- UX latency/quality failure: fix router/frontdesk handling before release.
- Internal correctness failure: fix state transitions/side effects before release.
- Human satisfaction failure: tighten response style/behavior, then re-test.

## Agent Routing

| Step | Agent | Mode | Notes |
|------|-------|------|-------|
| User satisfaction judgment | opus | — | Subjective quality assessment |
| Probe scripts | verifier | bg | `bash scripts/jarvis-ops.sh happiness-gate` |
| Evidence collection | scout | fg | Gather UX latency/quality data |
