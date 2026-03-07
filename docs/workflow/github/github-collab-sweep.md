# GitHub Collaboration Sweep

## Purpose

Session-start ritual that reads shared GitHub state so both Claude and Codex begin every session aware of what the other agent left behind. Prevents stale discussions, ownerless Issues, and invisible handoffs.

## Doc Type

`workflow-loop`

## Canonical Owner

This document owns the session-start GitHub sweep protocol.
Day-to-day collaboration rules remain in `docs/workflow/github/github-agent-collaboration-loop.md`.

## Use When

At the start of every Claude or Codex session, before any task work begins.

## Do Not Use When

- You are setting up the GitHub collaboration stack for the first time; use `docs/workflow/github/github-multi-agent-collaboration-loop.md`.
- You are changing day-to-day collaboration rules (Discussion/Issue/Project contracts); use `docs/workflow/github/github-agent-collaboration-loop.md`.
- You are changing governance, auth, or review automation policy; use `docs/workflow/github/nanoclaw-github-control-plane.md`.

## Verification

```bash
bash scripts/workflow/gh-collab-sweep.sh --agent claude
bash scripts/workflow/gh-collab-sweep.sh --agent codex
```

Both should run without error. Stale discussions and open handoffs in the output require action before proceeding.

## Command

```bash
# Claude
bash scripts/workflow/gh-collab-sweep.sh --agent claude

# Codex
bash scripts/workflow/gh-collab-sweep.sh --agent codex
```

## What the Sweep Checks

| Section | What it Shows | Why |
|---------|--------------|-----|
| My Issues | Open Project items where Agent=me, status != Done | Resume owned work |
| Needs My Review | Items where Review Lane=me and status=Review | Unblock the other agent |
| Stale Discussions | 0-comment discussions in my affinity categories | Prevent permanent drift |
| Handoffs from other agent | Issue comments with `<!-- agent-handoff -->` marker | Async message-passing |
| Blocked items | Any Project item with status=Blocked | Surface dependencies |

## Agent-Category Affinity

Each agent owns first response for a subset of Discussion categories.

| Category | First Responder | Rationale |
|----------|----------------|-----------|
| Workflow / Operating Model | Claude | Process and docs work |
| Claude/Codex Collaboration | Claude | Self-aware coordination |
| Feature Ideas | Codex | Implementation-leaning |
| SDK / Tooling Opportunities | Codex | Tooling-leaning |
| Upstream NanoClaw Sync | Codex | Tracks upstream commits |

First responder does not mean sole owner. After initial response, either agent may continue.

## Handoff Comment Format

When leaving work for the other agent on an Issue or Discussion, post a comment in this format:

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
| Stale Discussions | Post response or declare output (accepted/deferred/rejected/reference-only) |
| Handoffs from other agent | Acknowledge and act or comment with status |
| Blocked items | Assess if you can unblock; if not, leave comment |

## Stale Discussion Rule

A discussion is stale if:

1. Zero comments AND
2. In the agent's affinity category

Required action: post a comment before starting task work. Minimum output is one of:

- `Accepted → opening Issue #N`
- `Deferred — reason: <reason>`
- `Rejected — reason: <reason>`
- `Reference only — no action needed`

## Session End Contract

When ending a session with in-progress or blocked work that the other agent should pick up:

1. Post a handoff comment on the relevant Issue using the format above.
2. Update Project status (`Blocked`, `Review`) to reflect current state.
3. Run `qctx --close` for local session handoff as usual.

## Related Docs

- `docs/workflow/github/github-agent-collaboration-loop.md` — day-to-day collaboration rules
- `docs/workflow/runtime/session-recall.md` — local session recall (run before sweep)
- `docs/workflow/github/nanoclaw-github-control-plane.md` — governance and automation policy
