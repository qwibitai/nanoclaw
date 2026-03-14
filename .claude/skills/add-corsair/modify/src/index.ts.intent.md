# Intent: src/index.ts modifications

## What changed
Added Corsair MCP server, Corsair webhook server, and internal webhook listener server startup to `main()`. Updated `startIpcWatcher` to use `runAgent` with a streaming `onOutput` callback (replaces old `triggerAgent` approach). Added webhook listener snapshot writes to `runAgent`.

## Key sections

### Imports (top of file, after container-runner imports)
- Added: `startCorsairMcpServer` from `./corsair-mcp.js`
- Added: `startCorsairWebhookServer` from `./corsair-webhooks.js`
- Added: `startWebhookServer` from `./webhook-server.js`
- Added: `writeWebhookListenersSnapshot` to the existing `./container-runner.js` import block
- Added: `getAllWebhookListeners` to the existing `./db.js` import block

### runAgent() — webhook listeners snapshot
After `writeTasksSnapshot(...)`, added:
```typescript
const webhookListeners = getAllWebhookListeners();
writeWebhookListenersSnapshot(group.folder, isMain, webhookListeners);
```

### main() — Corsair server startup (after startSchedulerLoop)
```typescript
const corsairMcpPort = parseInt(process.env.CORSAIR_MCP_PORT || envSecrets.CORSAIR_MCP_PORT || '4002', 10);
startCorsairMcpServer(corsairMcpPort);
startCorsairWebhookServer(4001);  // external-facing: Slack/Linear/etc. post here
startWebhookServer({              // internal: routes events to SQLite-backed listeners
  registeredGroups: () => registeredGroups,
  getAllWebhookListeners,
  runAgent: (group, prompt, jid) => runAgent(group, prompt, jid, async (output) => {
    if (output.result) {
      const channel = findChannel(channels, jid);
      if (channel) await channel.sendMessage(jid, formatOutbound(output.result));
    }
    if (output.status === 'success' || output.status === 'error') {
      setTimeout(() => queue.closeStdin(jid), 10000);
    }
  }),
});
```

### startIpcWatcher() call — runAgent dep
Replace the old `triggerAgent` dep with `runAgent` using the same streaming callback pattern:
```typescript
runAgent: (group, prompt, jid) => runAgent(group, prompt, jid, async (output) => {
  if (output.result) {
    const channel = findChannel(channels, jid);
    if (channel) await channel.sendMessage(jid, formatOutbound(output.result));
  }
  if (output.status === 'success' || output.status === 'error') {
    setTimeout(() => queue.closeStdin(jid), 10000);
  }
}),
```

The `onOutput` callback activates streaming mode so output markers are processed
immediately rather than waiting for the container to exit (which it never does
while the MCP stdio server stays alive). `closeStdin` 10 s after completion reaps it.

## Invariants
- All existing channel setup, message loop, scheduler, and IPC logic unchanged
- Shutdown handlers unchanged
- `loadState()` / `saveState()` unchanged
- The user-facing `processGroupMessages → runAgent` path completely unchanged

## Must-keep
- The `isDirectRun` guard at the bottom
- The `_setRegisteredGroups` test helper
- The `escapeXml` and `formatMessages` re-exports
- All error handling and cursor rollback in `processGroupMessages`
