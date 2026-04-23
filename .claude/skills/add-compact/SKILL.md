---
name: add-compact
description: "Add /compact command for context compaction. When a conversation grows long, users send /compact in the group to summarize and compress context, freeing up the context window. Uses Claude Agent SDK's official Compaction API."
---

# Add /compact Command

This skill adds context compaction support to NanoClaw. When users send `/compact` in a group chat, the agent's conversation history is summarized and compressed, reclaiming context window space while preserving key information.

**What this adds:**
- `/compact` slash command recognition in the message loop
- Manual compaction via `/compact` (with optional custom instructions)
- Automatic compaction when token count exceeds a configurable threshold
- Audit logging of compaction events

**What stays the same:**
- PreCompact hook (already archives full transcripts before compaction)
- IPC protocol (reuses existing message piping to active containers)
- All other message handling

## Background

The Claude Agent SDK provides a Compaction API (beta `compact-2025-01-12`) via the `context_management` option in `query()`. When triggered:
1. The SDK summarizes the conversation, preserving key context
2. The existing PreCompact hook archives the full transcript to `conversations/`
3. The session continues with a compressed context

## 1. Add COMPACT_THRESHOLD to Config

Edit `src/config.ts`. Add after the `IDLE_TIMEOUT` export:

```typescript
// Token threshold for automatic context compaction
// When conversation exceeds this, the SDK auto-compacts
export const COMPACT_THRESHOLD = parseInt(
  process.env.COMPACT_THRESHOLD || '150000',
  10,
);
```

## 2. Detect /compact Command in Message Loop

Edit `src/index.ts`.

### 2a. Import COMPACT_THRESHOLD

Add `COMPACT_THRESHOLD` to the config import:

```typescript
// Before:
import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';

// After:
import {
  ASSISTANT_NAME,
  COMPACT_THRESHOLD,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
```

### 2b. Add /compact detection in processGroupMessages

Inside `processGroupMessages()`, add compact detection after the trigger check block and before the `formatMessages` call. When `/compact` is detected, inject a special instruction that the agent-runner will recognize:

```typescript
  // Detect /compact command
  const compactMessage = missedMessages.find((m) =>
    m.content.trim().startsWith('/compact'),
  );
  if (compactMessage) {
    const instructions = compactMessage.content.slice('/compact'.length).trim();
    const compactPrompt = `[SYSTEM: COMPACT_REQUEST] ${instructions || 'Summarize the conversation, preserving key decisions, code snippets, and action items.'}`;

    // Advance cursor
    const previousCursor = lastAgentTimestamp[chatJid] || '';
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();

    logger.info(
      { group: group.name, requestedBy: compactMessage.sender },
      'Compact requested',
    );

    // If container is already running, pipe the compact request
    if (queue.sendMessage(chatJid, compactPrompt)) {
      await channel.sendMessage(chatJid, '🗜️ Compacting context...');
      return true;
    }

    // No active container — run a new agent with the compact prompt
    await channel.sendMessage(chatJid, '🗜️ Compacting context...');

    const output = await runAgent(group, compactPrompt, chatJid, async (result) => {
      if (result.result) {
        const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (text) {
          await channel.sendMessage(chatJid, text);
        }
      }
    });

    if (output === 'error') {
      await channel.sendMessage(chatJid, '⚠️ Compaction failed. Try again later.');
    }

    return output !== 'error';
  }
```

**Important:** This block must go AFTER the trigger check but BEFORE the existing `const prompt = formatMessages(missedMessages);` call. The `channel` variable is already available from `findChannel()` earlier in the function.

### 2c. Add /compact detection in startMessageLoop piping path

In `startMessageLoop()`, inside the `for (const [chatJid, groupMessages] of messagesByGroup)` loop, add compact detection after the channel lookup and before the `needsTrigger` check:

```typescript
          // Check for /compact command — always process regardless of trigger
          const compactMsg = groupMessages.find((m) =>
            m.content.trim().startsWith('/compact'),
          );
          if (compactMsg) {
            const instructions = compactMsg.content.slice('/compact'.length).trim();
            const compactPrompt = `[SYSTEM: COMPACT_REQUEST] ${instructions || 'Summarize the conversation, preserving key decisions, code snippets, and action items.'}`;

            if (queue.sendMessage(chatJid, compactPrompt)) {
              logger.debug({ chatJid }, 'Piped compact request to active container');
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();
            } else {
              // No active container — enqueue for processing by processGroupMessages
              queue.enqueueMessageCheck(chatJid);
            }
            continue;
          }
```

This block should go after the `if (!channel)` guard and before the `const isMainGroup` / `needsTrigger` check.

## 3. Add context_management to Agent Runner

Edit `container/agent-runner/src/index.ts`.

### 3a. Add COMPACT_THRESHOLD constant

Add near the top of the file, after the existing constants:

```typescript
const COMPACT_THRESHOLD = parseInt(process.env.COMPACT_THRESHOLD || '150000', 10);
```

### 3b. Add context_management to query() options

In the `runQuery()` function, add `context_management` to the options object passed to `query()`. Add after the `hooks` property:

```typescript
      // Context compaction: auto-compact when token count exceeds threshold
      context_management: {
        edits: [{
          type: 'compact_20250112' as const,
          trigger: { type: 'input_tokens', value: COMPACT_THRESHOLD },
          instructions: 'Preserve key context: user requests, decisions made, code snippets discussed, and pending action items. Summarize routine exchanges.',
        }],
      },
```

## 4. Pass COMPACT_THRESHOLD to Container Environment

Edit `src/container-runner.ts`.

### 4a. Import COMPACT_THRESHOLD

Add `COMPACT_THRESHOLD` to the config import:

```typescript
// Before:
import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';

// After:
import {
  COMPACT_THRESHOLD,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
```

### 4b. Add COMPACT_THRESHOLD to container environment

In `buildContainerArgs()`, add the environment variable after the existing `TZ` env var:

```typescript
  // Pass compact threshold to container
  args.push('-e', `COMPACT_THRESHOLD=${COMPACT_THRESHOLD}`);
```

## 5. Update Existing Tests

Edit `src/container-runner.test.ts`.

The config mock needs `COMPACT_THRESHOLD`. Add it to the existing mock:

```typescript
// Before:
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// After:
vi.mock('./config.js', () => ({
  COMPACT_THRESHOLD: 150000,
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));
```

## 6. Verify and Test

### 6a. Build

```bash
npm run build
```

Ensure no TypeScript errors.

### 6b. Run existing tests

```bash
npm test
```

All existing tests should pass without modification.

### 6c. Manual test

1. Start NanoClaw: `npm run dev`
2. In a registered group, send `/compact`
3. Expected: Bot replies "🗜️ Compacting context..." and the agent processes the compaction
4. Send `/compact Keep only the last task discussion` to test custom instructions
5. Verify `groups/{name}/conversations/` has a new archived transcript

### 6d. Auto-compaction test

Auto-compaction triggers when token count exceeds `COMPACT_THRESHOLD`. To test with a lower threshold:

```bash
COMPACT_THRESHOLD=5000 npm run dev
```

Then have a long conversation and observe the PreCompact hook archiving the transcript.

## Summary of Changed Files

| File | Type of Change |
|------|----------------|
| `src/config.ts` | Add `COMPACT_THRESHOLD` config constant |
| `src/index.ts` | Detect `/compact` command, route to agent |
| `src/container-runner.ts` | Import `COMPACT_THRESHOLD`, pass env to container |
| `container/agent-runner/src/index.ts` | Add `context_management` to SDK query |
| `src/container-runner.test.ts` | Add `COMPACT_THRESHOLD` to config mock |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPACT_THRESHOLD` | `150000` | Token count threshold for auto-compaction |

## Security Notes

- `/compact` can be sent by anyone in a registered group (follows NanoClaw's group trust model)
- PreCompact hook always archives the full transcript before compaction (already implemented)
- Compaction is per-session: it only affects the current agent session for that group
