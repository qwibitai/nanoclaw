# `react_to_message` MCP Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the container agent (Andy) send WhatsApp emoji reactions via a new MCP tool.

**Architecture:** Add `react_to_message` to the existing MCP stdio server. It writes an IPC file with `type: 'reaction'`. The host IPC watcher detects it and calls `sendReaction()` or `reactToLatestMessage()` on the channel. Same auth model as `send_message`.

**Tech Stack:** TypeScript, Zod, MCP SDK, better-sqlite3 (for `getLatestMessageId`)

**Design doc:** `docs/plans/2026-02-24-react-to-message-mcp-tool-design.md`

---

### Task 1: Add `react_to_message` MCP tool

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (after `send_message` tool, line 63)

**Step 1: Add the tool registration**

Insert after the `send_message` tool (after line 63):

```typescript
server.tool(
  'react_to_message',
  'React to a message with an emoji. Omit message_id to react to the most recent message in the chat.',
  {
    emoji: z.string().describe('The emoji to react with (e.g. "👍", "❤️", "🔥")'),
    message_id: z.string().optional().describe('The message ID to react to. If omitted, reacts to the latest message in the chat.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'reaction',
      chatJid,
      emoji: args.emoji,
      messageId: args.message_id || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Reaction ${args.emoji} sent.` }] };
  },
);
```

**Step 2: Verify it compiles**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: add react_to_message MCP tool for container agents"
```

---

### Task 2: Add `sendReaction` to IPC deps and wire it up in index.ts

**Files:**
- Modify: `src/ipc.ts` (IpcDeps interface, line 21-34)
- Modify: `src/index.ts` (startIpcWatcher call, line 557-569)

**Step 1: Extend IpcDeps interface**

In `src/ipc.ts`, add to the `IpcDeps` interface (after `sendMessage` on line 22):

```typescript
sendReaction: (jid: string, emoji: string, messageId?: string) => Promise<void>;
```

**Step 2: Wire up in index.ts**

In `src/index.ts`, add `sendReaction` to the `startIpcWatcher({...})` call (after `sendMessage` closure, line 562):

```typescript
sendReaction: async (jid, emoji, messageId) => {
  const channel = findChannel(channels, jid);
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (messageId) {
    const messageKey = { id: messageId, remoteJid: jid, fromMe: false };
    await channel.sendReaction!(jid, messageKey, emoji);
  } else {
    await channel.reactToLatestMessage!(jid, emoji);
  }
},
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/ipc.ts src/index.ts
git commit -m "feat: add sendReaction to IPC deps interface"
```

---

### Task 3: Handle `type: 'reaction'` in IPC message processing

**Files:**
- Modify: `src/ipc.ts` (message processing loop, lines 85-103)

**Step 1: Add reaction handling**

In the message-processing block inside `processIpcFiles()`, after the existing `if (data.type === 'message' ...)` block (line 85-102), add an `else if` for reactions:

```typescript
else if (data.type === 'reaction' && data.chatJid && data.emoji) {
  const targetGroup = registeredGroups[data.chatJid];
  if (
    isMain ||
    (targetGroup && targetGroup.folder === sourceGroup)
  ) {
    try {
      await deps.sendReaction(data.chatJid, data.emoji, data.messageId);
      logger.info(
        { chatJid: data.chatJid, emoji: data.emoji, sourceGroup },
        'IPC reaction sent',
      );
    } catch (err) {
      logger.error(
        { chatJid: data.chatJid, emoji: data.emoji, sourceGroup, err },
        'IPC reaction failed',
      );
    }
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC reaction attempt blocked',
    );
  }
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Update test mocks**

In `src/channels/whatsapp.test.ts`, find the IPC deps mock (search for `sendMessage` mock) and add `sendReaction` if the mock needs it. The mock just needs `sendReaction: vi.fn()` alongside `sendMessage: vi.fn()`.

**Step 4: Run tests**

Run: `npx vitest run`
Expected: all 389+ tests pass

**Step 5: Commit**

```bash
git add src/ipc.ts src/channels/whatsapp.test.ts
git commit -m "feat: handle reaction IPC messages in host watcher"
```

---

### Task 4: Build, deploy, and live test

**Step 1: Build**

Run: `npm run build`

**Step 2: Rebuild agent container** (picks up new MCP tool)

Run: `./container/build.sh`

**Step 3: Restart service**

Run: `systemctl --user restart nanoclaw`

**Step 4: Live test**

Send a message in WhatsApp, then ask Andy to react to it. Verify the reaction appears. Check logs:

```bash
grep -i "reaction" logs/nanoclaw.log | tail -10
```

**Step 5: Commit any fixes and push**

```bash
git push origin feat/add-reactions-skill
```
