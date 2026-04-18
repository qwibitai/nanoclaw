# QA Autopilot — Implementation Plan

**Status:** draft · **Created:** 2026-04-17 · **Owner:** Jonathan

Ship a three-lane QA system that catches regressions before you notice
them, diagnoses them, and drafts fixes for your one-tap approval. Phase 1
(invariants runner) already shipped as `scripts/qa-check.ts` in commit
`835535b`. This plan covers the remaining three lanes.

## Success criteria

- **Monitors:** a failure transition in any invariant produces a Telegram
  ping within 60s. No pings when the run is a pass.
- **Scenarios:** ≥10 scripted UX scenarios run on demand, each with a
  pass/fail verdict. False-positive rate < 5% across a week.
- **Auto-propose-fix:** when any invariant/scenario fails, an agent in a
  git worktree produces a diagnosis + diff on a feature branch and posts
  a Telegram approval card within 5 minutes. Zero unattended merges to
  `main`.

## Prerequisites (already done)

- `scripts/qa-check.ts` with 13 invariants. Run: `npm run qa:check`.
- Invariants cover DB state, logs, HTTP, env. Exit 0/1/2.

---

## Lane 1 — Monitors (cron + notify)

**Goal:** run `qa:check` on a schedule and ping Telegram only on
**transitions** from pass to fail (and fail-to-pass recovery).

### Files

- `scripts/qa-monitor.ts` — wraps `qa-check.ts` as a library, persists
  last-run state to `data/qa-state.json`, sends Telegram on transitions.
- `scripts/qa-check.ts` — refactor `run()` into an exported function
  that returns `Result[]` without calling `process.exit`. CLI entry
  stays at the bottom.
- `data/qa-state.json` — `{ "runAt": ms, "byInvariant": { [name]: "pass"|"fail" } }`.
  Gitignored.

### Flow

1. `qa-monitor` runs every 10 minutes via launchd (new plist or reuse
   `com.nanoclaw` with a scheduled task via the existing `task-scheduler`).
2. Diff current results against persisted state.
3. For each invariant that transitioned:
   - `pass → fail` — send `⚠️ QA: <name> failed — <message>` to
     `EMAIL_INTEL_TG_CHAT_ID`.
   - `fail → pass` — send `✅ QA: <name> recovered`.
4. Write new state to `qa-state.json`.

### Tasks

- [ ] Extract `runAll()` and `Result` types from `qa-check.ts` into
      `scripts/qa/invariants.ts` (shared module).
- [ ] Create `scripts/qa/monitor.ts` with state diffing + Telegram notify.
      Reuses `sendTelegramMessage` from `src/channels/telegram.ts`.
- [ ] Wire a `qa:monitor` npm script.
- [ ] Add a launchd plist `com.nanoclaw.qa-monitor.plist` with
      `StartInterval: 600`. Or add a scheduled task via the existing
      in-process `task-scheduler.ts` if we prefer that path.
- [ ] Document: how to pause monitoring (`QA_MONITOR_DISABLED=1` env var).

### Failure modes

- Telegram down → log warn, retry next cycle. State file still advances.
- `qa:check` itself crashes → emit ` 💥 QA: runner crashed` alert. Don't
  retry-storm (backoff). Persist crash-count so repeated crashes alert.
- Noisy invariant → add `ok: true` short-circuit with a comment
  (`// warn-only`) and move on.

### Estimate

~1 hour. Pure glue code.

---

## Lane 2 — Scenarios (chat UX tests)

**Goal:** scripted Telegram conversations that exercise real code paths
and assert on responses. Covers UX bugs invariants can't see (wrong
button layout, confusing wording, missing buttons).

### Architecture: in-process test channel

Avoid second Telegram account. Register a synthetic channel in
`src/channels/registry.ts` under the name `test_harness` that:

- Implements the `Channel` interface (`sendMessage`, `sendMessageWithActions`,
  `setTyping`, `editMessage`, `editMessageButtons`, `setChatMenuButton`,
  etc. from `src/types.ts`).
- **Outbound:** instead of hitting a network, appends each outbound call
  to an in-memory ring buffer keyed by chat JID.
- **Inbound:** exposes a `ScenarioRunner.inject(chatJid, message)` method
  that writes a row to `messages` table (same shape as real
  Telegram-received messages) and signals the agent loop.
- Lifecycle: channel is registered only when `NANOCLAW_TEST_HARNESS=1`;
  production startup is unaffected.

### Files

- `src/channels/test_harness.ts` — channel implementation + ring-buffer
  output capture.
- `scripts/qa/scenarios.ts` — the scenario runner.
- `scripts/qa/scenarios/*.json` — one file per scenario.
- `scripts/qa/judge.ts` — LLM judge with rubric.

### Scenario schema

```json
{
  "name": "attention-card-has-4-buttons-1-row",
  "description": "Pushing an attention item must render a single-row keyboard with exactly 4 buttons",
  "setup": {
    "insertTrackedItem": {
      "classification": "push",
      "queue": "attention",
      "sender": "chase@chase.com",
      "title": "Account alert"
    }
  },
  "trigger": {
    "type": "direct_call",
    "call": "pushAttentionItem",
    "args": { "chatId": "test:0", "itemId": "<setup.id>", "title": "Account alert", "sender": "chase@chase.com", "reason": "test" }
  },
  "expect": {
    "outbound": {
      "kind": "message_with_keyboard",
      "inline_keyboard": {
        "rows": 1,
        "buttons": 4,
        "callback_data_patterns": ["triage:snooze:1h:", "triage:snooze:tomorrow:", "triage:dismiss:", "triage:archive:"]
      }
    }
  }
}
```

### Scenario catalog (seed set — ship with 10)

1. **attention-card-layout** — 1 row, 4 buttons, no "Archive queue" row.
2. **archive-from-attention-records-negative-example** — click
   `triage:archive:X`, assert `triage_examples` row has `kind='negative'`.
3. **snooze-1h-updates-state** — click snooze, assert `tracked_items.state='held'`
   and `metadata.snoozed_until` is ~1h out.
4. **miniapp-root-renders** — GET /, expect 200 with both queue sections.
5. **miniapp-bulk-archive-happy-path** — insert 5 archive_candidate
   rows, POST `/api/archive/bulk` with all 5 ids, expect
   `{ archived: 5, requested: 5 }` and all rows resolved.
6. **miniapp-bulk-archive-ignores-non-archive-rows** — POST with mixed
   ids (some attention, some archive), expect only archive ones resolved.
7. **empty-attention-dashboard-no-edit** — call `renderAttentionDashboard`
   with `items: []`, assert no outbound `editMessageText`.
8. **archive-all-command-via-chat** — inject `archive all` as user
   message, assert reply contains `Archived N items.` and DB reflects.
9. **ignore-classification-auto-resolves** — mock classifier to return
   `queue='ignore'`, assert inserted row ends up `state='resolved'`.
10. **parallel-commands-batched** — inject 3 unrelated messages in one
    turn, capture outbound calls, assert tool calls fired in a single
    turn (not serialized across turns). Requires adding a counter to
    the agent container's turn-boundary instrumentation.

### Judge rubric

Most assertions are structural (button counts, DB rows, HTTP status) and
don't need an LLM. For the ~20% that do (e.g., "response is clear and
non-redundant"), use a small Claude call with:

- Prompt template: `You are a QA judge. Here is the scenario goal,
  the input, and the system's response. Return JSON { ok: boolean,
  reasons: string[] }. Be strict — flag any failure mode the goal
  implies.`
- Model: `claude-haiku-4-5` (fast + cheap, same as triage tier 1).
- Cache the scenario goal + rubric as a prompt-cache breakpoint so
  replays are cheap.

### Tasks

- [ ] Design `Channel` interface audit. What methods must the shim
      implement? Read `src/channels/telegram.ts` exports.
- [ ] Implement `src/channels/test_harness.ts` — register under
      `test_harness`, gated on `NANOCLAW_TEST_HARNESS=1`.
- [ ] Implement `scripts/qa/scenarios.ts` — parses JSON, runs setup,
      triggers, captures outbound, invokes judge, reports verdict.
- [ ] Write the 10 seed scenarios.
- [ ] Implement `scripts/qa/judge.ts` — LLM evaluator with caching.
- [ ] Wire `npm run qa:scenarios` (CLI) and `qa:all` that chains
      invariants + scenarios.
- [ ] Add scenarios to monitor's notify path when their verdict
      transitions.

### Failure modes

- Scenario depends on a mock that drifts out of sync → judge reports
  fail, we fix the scenario. Invariant-style review.
- Real agent response is slow → scenario runner has a 30s timeout per
  step.
- LLM judge has hallucinated reasoning → log the full judge prompt +
  response to `.omc/logs/qa-judge/YYYY-MM-DD.jsonl` for post-hoc review.

### Estimate

3–5 hours. Shim is the biggest piece; the rest is scripting.

---

## Lane 3 — Auto-propose-fix

**Goal:** on any QA failure, dispatch an agent to a git worktree,
produce a diagnosis + diff + tests, push a branch, send a Telegram
approval card. Zero unattended merges.

### Architecture

```
qa:check / qa:scenarios fails
    ↓
qa:propose-fix
    ├─ allocate worktree under .claude/worktrees/qa-fix-<hash>
    ├─ dispatch Claude Code agent with:
    │     - failure report (which invariant/scenario, message, details)
    │     - repo access in worktree
    │     - instructions: diagnose, fix, add regression test,
    │       commit to branch `qa/fix-<slug>-<date>`
    ├─ classify risk (LOW / MED / HIGH) via a rubric
    ├─ push branch to origin
    └─ post Telegram card:
         🧪 QA: <invariant> failed
         Proposed fix: <branch>
         Risk: <LOW/MED/HIGH>
         Diff summary: +<N> −<M> across <K> files
         Reasons: <2–3 bullets from the agent's diagnosis>
         [✓ Merge] [✕ Close] [🔍 Details]
```

### Risk classifier rubric

Automated, cheap heuristics first; LLM only for ambiguous cases.

- **LOW:** changes only in `docs/**`, `scripts/qa/**`, test files, or
  SQL-only idempotent migrations. No `src/` production code.
- **MED:** `src/triage/**`, `src/mini-app/**`, single-file changes
  under 50 lines with a new test.
- **HIGH:** anything touching `src/index.ts`, `src/container-runner.ts`,
  `src/db.ts` schema, channel implementations, or multi-file refactors.

### Approval flow

- `[✓ Merge]` — server runs `git checkout main && git merge --ff-only
  <branch> && git push && <build-and-restart>`. Posts ` 🚀 merged`
  confirmation.
- `[✕ Close]` — deletes the worktree and the remote branch. Logs
  rejection reason if user adds one via reply.
- `[🔍 Details]` — opens the mini-app to a page rendering the full agent
  transcript and diff.

### Files

- `scripts/qa/propose-fix.ts` — orchestrator. Takes a failure report,
  allocates worktree, dispatches agent, classifies risk, posts approval.
- `scripts/qa/approval-server.ts` — mini-app route `POST /api/qa/approve`
  that handles the button callbacks. Triggered from existing
  `callback-router.ts`.
- `src/callback-router.ts` — add `qa:merge:<id>`, `qa:close:<id>`,
  `qa:details:<id>` cases.
- `data/qa-proposals/<id>.json` — persisted proposal state
  (branch name, worktree path, failure report, agent transcript path).

### Guardrails

- **Never touches `main` directly.** All writes on feature branches.
- **Never merges without explicit approval.** Even LOW-risk proposals
  wait for a tap. (Later: allow a whitelist of truly idempotent
  fixes to auto-apply — but not in this phase.)
- **Worktree isolation.** Each proposal gets its own worktree so
  multiple failures can be diagnosed in parallel without conflict.
- **Tests must pass on the branch.** Agent runs `npm test` before
  pushing; if red, abort and send a fail notification instead of
  approval card.
- **Agent budget cap.** 10 tool calls max per diagnosis, 5 min wall
  clock. Beyond that, report "couldn't reproduce" instead of thrashing.

### Tasks

- [ ] Write `scripts/qa/propose-fix.ts` — skeleton + worktree alloc.
- [ ] Dispatch agent via the `Agent` tool / Claude Agent SDK with the
      worktree scoped as `cwd`. Reuse the deep-work pattern from
      `container/agent-runner/src/index.ts:548-587`.
- [ ] Risk classifier — start with the pure heuristic rules above.
- [ ] Mini-app approval route + Telegram callback handlers.
- [ ] `npm run qa:propose-fix -- --failure <path-to-failure-json>`.
- [ ] Integration: monitor's Telegram ping now includes a
      `🔧 Propose fix` button that kicks `qa:propose-fix`.
- [ ] Document the approval workflow in this file's Appendix.

### Failure modes

- Agent produces empty diff → post ` 🤷 QA: couldn't produce a fix
  for <invariant>` with transcript link.
- Agent produces a diff that fails tests → same as above, plus test
  output in the Telegram message.
- Risk classifier misclassifies → start conservative (err toward HIGH),
  tune after a week of real use.
- Stale worktree accumulates → weekly cleanup script removes worktrees
  > 7 days old (unless branch is merged).

### Estimate

4–6 hours. Agent dispatch is the riskiest piece.

---

## Rollout order

1. **Week 1 — Monitors.** Ship in a day. Run against the current
   invariants for a week. Tune false-positives. Get used to the
   notification cadence.
2. **Week 2 — Scenarios.** Ship the shim and 10 seed scenarios. Add
   scenarios for each UX issue that comes up during normal use.
3. **Week 3+ — Auto-propose-fix.** Only after scenarios have been
   running for a week and the judge feels reliable. Start with
   approval-required for ALL risk tiers. Consider auto-apply for
   specific LOW-risk invariants only after 4+ weeks of approval-flow
   use builds trust.

## Non-goals

- **Not building a general-purpose test framework.** Scenarios are
  nanoclaw-specific; reuse is not a design goal.
- **Not replacing vitest.** Unit tests stay in `src/__tests__/`.
  QA autopilot is the outer layer that catches drift between code
  and live state.
- **Not auto-fixing SuperPilot.** Cross-repo auto-fix is explicitly
  out of scope. Failures there get a manual-fix notification.

## Open questions

- **Where does auto-propose-fix run?** Same nanoclaw process, or a
  separate long-lived harness? Lean toward same process to simplify;
  budget cap keeps it bounded.
- **Rate limiting.** If 5 invariants fail at once, do we produce 5
  approval cards or batch into one? Probably one per failed invariant,
  but collapse in the card if they share a root cause.
- **Historical QA results.** Store in DB under `qa_runs` table or just
  files? Probably DB for queryability — "show me all failures of
  classifier-liveness in the last month."

## Appendix: signals to monitor over time

- **False-positive rate per invariant.** If > 5% over a week, retune
  threshold or make warn-only.
- **Approval latency.** How long from proposal posted to user clicks?
  If it's always instant, some LOW-risk fixes graduate to auto-apply.
- **Bug classes found by each lane.** Tells us where to invest —
  scenarios catching most bugs means we need more scenarios; invariants
  catching most means our code is shipping with config drift and we
  should fix the deploy process, not add more tests.
