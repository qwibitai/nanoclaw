# Long-Running Task Continuation

**Date:** 2026-04-01
**Status:** Draft

## Problem

Agent containers have a 30-minute hard timeout. Long-running coding tasks (refactors, multi-file implementations, overnight scheduled work) regularly exceed this limit. Today, the user manually batches work into smaller prompts or re-prompts after timeout. This is tedious and the current experience is opaque — there's no visibility into what happened across container boundaries.

## Solution

Two complementary changes:

1. **Per-group timeout override** (quick win) — expose the existing `group.containerConfig?.timeout` path so groups can configure longer timeouts.
2. **Host-managed continuation loop** (core feature) — on hard timeout, the host automatically re-spawns a new container with a continuation prompt. The agent self-orients from git state and external context.

## Design

### Per-Group Timeout Override

The code path already exists in container-runner.ts (`group.containerConfig?.timeout`). This change makes it usable:

- Groups can set a `timeout` field in their configuration.
- Default remains 30 minutes (1,800,000 ms).
- No enforced upper bound in code. Document that API rate limits and context window exhaustion are the practical ceiling, not the timeout itself.

### Host-Managed Continuation Loop

#### Trigger Condition

On container exit, if the `timedOut` flag is true (hard timeout, not clean exit), the host spawns a continuation. No heuristic for "is the work done" — the agent judges completeness. If it finds nothing to do, it exits cleanly.

- Hard timeout → continue (up to max retries)
- Clean exit (agent sent `_close` or idle timeout after output) → done
- Max continuations reached → stop, notify user

#### Continuation Prompt

The host constructs a minimal prompt with three pieces. The agent self-orients from there using its normal tools (git, Obsidian, Discord, group CLAUDE.md).

```
Your previous session was interrupted. You were working on the following task:

---
{original_prompt}
---

Your work started at commit {start_commit}. Check `git log {start_commit}..HEAD`
and the current repo state to understand what was accomplished. Continue where
you left off. If the task is already complete, confirm and exit.

(Continuation {n} of {max})
```

- **original_prompt**: The user's original message or task prompt, stored at first container launch.
- **start_commit**: HEAD at the time the first container in the chain was spawned.
- **n / max**: Current continuation number and configured maximum.

#### Configuration

Two new constants in config.ts:

| Constant | Default | Purpose |
|----------|---------|---------|
| `MAX_CONTINUATIONS` | 2 | Max re-spawns for interactive tasks |
| `SCHEDULED_TASK_MAX_CONTINUATIONS` | 5 | Max re-spawns for scheduled tasks |
| `CONTINUATION_COOLDOWN_MS` | 60000 | Delay before spawning continuation |

Both are overridable via environment variables, following the existing pattern.

#### State Tracking

Continuation state is tracked in-memory, keyed by group + original message ID:

- Original prompt
- Start commit hash
- Current continuation count

No database schema changes. If the NanoClaw process restarts, in-flight continuation chains are lost. This is acceptable — the user can re-prompt.

#### Implementation Scope

| File | Change |
|------|--------|
| `container-runner.ts` | After existing timeout/exit branching, add continuation check. On hard timeout with retries remaining, enqueue continuation after cooldown. Record start commit at container launch. |
| `group-queue.ts` | Continuation enqueued as a normal message with the constructed prompt. No special queue path. |
| `config.ts` | Add `MAX_CONTINUATIONS`, `SCHEDULED_TASK_MAX_CONTINUATIONS`, `CONTINUATION_COOLDOWN_MS` constants. |

Nothing touches IPC, the scheduler, the agent container, or the database.

#### Observability

- **Log continuation events** — "Container timed out for group X, spawning continuation 2/3 after cooldown" via the existing logger.
- **Chat notification on continuation** (interactive tasks only) — short message to the originating channel: "Task timed out, continuing automatically (2/3)."
- **Chat notification on exhaustion** (interactive tasks only) — "Task reached maximum continuations. Check progress and re-prompt if needed."
- Scheduled tasks log but do not send chat notifications.

## Out of Scope

- Agent-side awareness of time limits or remaining time
- Conversation state serialization or checkpoint/restore
- New IPC verbs or task types
- Agent-initiated continuation requests
- Dashboard or persistent continuation history
