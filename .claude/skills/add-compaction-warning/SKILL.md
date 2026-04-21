---
name: add-compaction-warning
description: Context compaction early warning system. Sends Signal (or any channel) notifications at 80% context usage and before auto-compaction. Lets users save important context before it's summarized. Also enables /context and /compact from chat.
---

# Add Compaction Warning System

Proactive context management for NanoClaw V2. Sends chat notifications when the agent's context window is filling up, giving you time to consolidate memory before auto-compaction summarizes older context.

**The problem:** During long work sessions (video iteration, code review, planning), the agent silently compacts context when it fills up. You lose the ability to say "remember X" before it's too late. At the terminal you see the warning — but from Signal or other chat channels, you're blind.

**The solution:** Three layers of visibility, all delivered to whatever channel you're chatting on:

## How it works

| Threshold | Tokens | What happens |
|-----------|--------|--------------|
| **On demand** | Any | Send `/context` — get current usage |
| **80% warning** | ~132k | Automatic notification: "Context 80% full. Send /compact or tell me what to save." |
| **Pre-compaction** | ~152k | Notification: "CONTEXT COMPACTION — Archived X messages. Tell me what to remember." |
| **Post-compaction** | — | Context summarized, session continues |

## What this adds

### 1. Active routing module (`container/agent-runner/src/active-routing.ts`)

Stores the current session's routing context (channel type, platform ID) so the compaction hooks can send notifications to the right channel — Signal, Nostr, Watch, whatever you're chatting on.

### 2. Enhanced PreCompact hook (`container/agent-runner/src/providers/claude.ts`)

The existing PreCompact hook archives transcripts. This enhancement adds:
- **80% early warning:** Monitors `input_tokens` from each assistant response. When it crosses 80% of the auto-compact window (165k default), sends a one-time notification to your chat channel.
- **Pre-compaction notification:** Before the SDK compacts, sends a message telling you compaction is happening and how many messages were archived.

### 3. Routing bridge (`container/agent-runner/src/poll-loop.ts`)

Sets the active routing context when a query starts, so the hooks know where to send notifications.

## Install

### Phase 1: Pre-flight

```bash
test -f container/agent-runner/src/active-routing.ts && echo "Already installed" || echo "Ready to install"
```

### Phase 2: Apply

```bash
git fetch origin skill/compaction-warning
git checkout origin/skill/compaction-warning -- container/agent-runner/src/active-routing.ts container/agent-runner/src/providers/claude.ts container/agent-runner/src/poll-loop.ts
```

### Phase 3: Rebuild container and restart

```bash
./container/build.sh
systemctl --user restart nanoclaw    # Linux
```

**Important:** Also copy the files to the agent-runner overlay so existing sessions pick them up without waiting for a new container image:

```bash
OVERLAY=data/v2-sessions/<your-agent-group-id>/agent-runner-src
cp container/agent-runner/src/active-routing.ts "$OVERLAY/"
cp container/agent-runner/src/providers/claude.ts "$OVERLAY/providers/"
cp container/agent-runner/src/poll-loop.ts "$OVERLAY/"
```

## Usage

- **`/context`** — check current usage anytime (already an admin command)
- **`/compact`** — manually trigger compaction on your terms (already an admin command)
- **Automatic warnings** — no action needed, they fire when thresholds are crossed

## Configuration

The auto-compact window defaults to 165,000 tokens (set in the Claude provider). Thresholds:

- Early warning: 80% of window (132,000 tokens)
- Auto-compaction: ~92% of window (152,000 tokens, set by SDK)

To change the window size, set the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment variable.

## How thresholds were determined

We reverse-engineered the Claude Agent SDK's compaction logic:

```
autoCompactThreshold = window - 13,000 tokens (~92%)
warningThreshold     = window - 20,000 tokens (~88%, SDK internal only)
blockingLimit        = window - 3,000 tokens  (~98%)
```

Our 80% early warning fires well before any of these, giving you ~20k tokens of breathing room.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| No warning at 80% | Container doesn't have updated code | Copy files to agent-runner overlay (see install) |
| `/context` returns nothing | Not an admin user | Check agent_group_members |
| Warning sent to wrong channel | Routing not set | active-routing.ts must be imported in poll-loop.ts |

## Removal

```bash
rm container/agent-runner/src/active-routing.ts
# Revert claude.ts and poll-loop.ts changes
./container/build.sh
systemctl --user restart nanoclaw
```
