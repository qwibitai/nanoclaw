# Collaboration Sweep

## Purpose

Session-start ritual that reads the active work control plane so both Claude and Codex begin every session aware of shared execution state. In this repository, Linear is the only supported active work queue.

## Doc Type

`workflow-loop`

## Canonical Owner

This document owns the session-start collaboration sweep protocol.
Day-to-day work-state rules remain in the active control-plane contract.

## Use When

At the start of every Claude or Codex session, before any task work begins.
Also use it immediately when `scripts/workflow/session-start.sh` exits blocked on required Linear review or triage actions so the blocked follow-up uses the same review/handoff rules.

## Do Not Use When

- You are changing the Linear/Notion/GitHub separation contract; use `docs/operations/workflow-setup-responsibility-map.md` plus the active collaboration-surface docs.
- You are changing governance, auth, or review automation policy; use `docs/workflow/github/github-delivery-governance.md`.

## Verification

```bash
bash scripts/workflow/session-start.sh --agent claude
bash scripts/workflow/session-start.sh --agent codex
```

Both should run without error. Review items, triage items, and handoffs shown by the sweep require action before proceeding.

## Command

Canonical entrypoint:

```bash
bash scripts/workflow/session-start.sh --agent claude
bash scripts/workflow/session-start.sh --agent codex
```

Sweep-only fallback:

```bash
bash scripts/workflow/work-sweep.sh --agent claude --fail-on-action-items
bash scripts/workflow/work-sweep.sh --agent codex --fail-on-action-items
```

The wrapper resolves the active control plane via `scripts/workflow/work-control-plane.js`.
Missing Linear configuration is a startup error.

## What the Sweep Checks

| Section | What it Shows | Why |
|---------|--------------|-----|
| My Issues | Linear issues labeled for the active agent | Resume owned work |
| Needs My Review | Linear issues in `Review` with a matching review label | Unblock the other agent |
| Triage Queue | Linear issues in `Triage` routed to the active agent | Clear intake before new execution |
| Nightly Context Handoffs | Pending shared-context research items awaiting Codex triage | Turn overnight research into selective morning action |
| Handoffs from other agent | Control-plane comments with `<!-- agent-handoff -->` marker | Async message-passing |
| Blocked items | Any blocked work item in the active control plane | Surface dependencies |

The session-start wrapper runs local recall first, then this sweep, then workflow preflight checks.

## Agent-Topic Affinity

Each agent owns first response for a subset of shared-context topics.

| Category | First Responder | Rationale |
|----------|----------------|-----------|
| Workflow / Operating Model | Claude | Process and docs work |
| Claude/Codex Collaboration | Claude | Self-aware coordination |
| Feature Ideas | Codex | Implementation-leaning |
| SDK / Tooling Opportunities | Codex | Tooling-leaning |
| Upstream NanoClaw Sync | Codex | Tracks upstream commits |

First responder does not mean sole owner. After initial response, either agent may continue.

## Handoff Comment Format

When leaving work for the other agent on an issue or linked delivery thread, post a comment in this format:

```
<!-- agent-handoff -->
From: claude
To: codex
Status: completed|blocked|needs-review|needs-input
Next: <specific next action, concrete enough to act on>
Context: <brief context — what was done, what remains>
```

The sweep reads `<!-- agent-handoff -->` markers in recent Issue comments and surfaces them.

## Required Responses to Sweep Output

| Sweep Section | Required Action |
|--------------|----------------|
| My Issues (Backlog/Ready) | Confirm still relevant; set In Progress if starting work |
| My Issues (Blocked) | Unblock or comment with blocker reason |
| Needs My Review | Complete review or leave handoff comment with timeline |
| Nightly Context Handoffs | Codex reviews, records a decision update, and promotes only if the next action is concrete |
| Handoffs from other agent | Acknowledge and act or comment with status |
| Blocked items | Assess if you can unblock; if not, leave comment |

### Review Lane Resolution Rule

If `Needs My Review` contains an item, resolve that review lane before starting unrelated task work.
This same flow applies when session start stops with `ACTION REQUIRED` because of review-lane items.

Required review flow:

1. Open the Linear issue and inspect its linked PR or GitHub PR reference first.
2. If a linked PR exists, open that PR immediately and perform the review there.
3. Use repo-qualified GitHub commands for lookups and review actions in this repository, for example:
   - `gh pr view -R ingpoc/nanoclaw <number>`
   - `gh pr diff -R ingpoc/nanoclaw <number>`
4. Do not rely on unqualified `gh pr view <number>` in this checkout because multiple remotes/default repos can resolve the same number to the wrong repository.
5. If the authenticated account cannot file a formal review because it owns the PR, leave an equivalent blocking or approval PR comment instead.
6. If no linked PR exists yet, leave an Issue comment or handoff comment stating the missing review artifact and next action.
7. If the review finding is on a Claude-authored PR and fixing it benefits from Claude's original implementation context, immediately switch into `docs/workflow/delivery/claude-cli-resume-consult-lane.md` and resume the exact Claude implementation session in an isolated PR worktree.

The review lane is only considered handled once one of these is true:

- the PR review is completed
- an equivalent PR comment is posted when formal review is not possible
- a concrete handoff comment with timeline/blocker is posted

### Startup Enforcement

When invoked with `--fail-on-action-items`, the sweep exits with status `3` if any of these remain:

- `Needs My Review` items
- `Triage` items routed to the active agent
- recent handoff comments from the other agent

This is the mode used by `scripts/workflow/session-start.sh`.

## Nightly Improvement Rule

The nightly findings section is read-only sweep output.

Codex should:

1. review the surfaced nightly upstream/tooling shared-context entries
2. follow the morning triage contract in `docs/workflow/strategy/nightly-evaluation-loop.md`
3. add an explicit Codex decision update for promoted and non-promoted findings
4. promote only when the next action is concrete enough for an execution Issue
5. leave a promotion summary update when promoted

The sweep itself must not auto-promote or auto-close nightly findings.
The nightly shared-context record should remain the rolling research thread unless the nightly workflow explicitly retires or replaces it.
Nightly findings should surface only when a newer Claude nightly decision handoff is waiting on Codex triage.

## Session End Contract

When ending a session with in-progress or blocked work that the other agent should pick up:

1. Post a handoff comment on the relevant Issue using the format above.
2. Update the active control-plane status (`Blocked`, `Review`) to reflect current state.
3. Run `qctx --close` for local session handoff as usual.

## Related Docs

- `docs/workflow/control-plane/collaboration-surface-contract.md` — day-to-day collaboration rules
- `docs/workflow/runtime/session-recall.md` — local session recall (run before sweep, or via `scripts/workflow/session-start.sh`)
- `docs/workflow/github/github-delivery-governance.md` — governance and automation policy
