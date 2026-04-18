# Intent: src/ipc.ts modifications

## What changed
- Replaced optional `triggerAgent` dep with required `runAgent` dep in `IpcDeps`
- Added `register_webhook_listener` and `remove_webhook_listener` IPC cases
- Updated `trigger_agent` case to use `runAgent` directly (looks up group from JID)
- Added webhook listener fields to the `processTaskIpc` data parameter type
- Added imports for webhook listener DB functions and snapshot writer

## Key sections

### IpcDeps interface — new deps
```typescript
runAgent: (group: RegisteredGroup, prompt: string, jid: string) => Promise<'success' | 'error'>;
getAllWebhookListeners: () => WebhookListener[];
writeWebhookListenersSnapshot: (groupFolder: string, isMain: boolean) => void;
```

### processTaskIpc data type — new fields
```typescript
plugin?: string;
action?: string;
prompt_template?: string;
target_jid?: string;
listenerId?: string;
```

### trigger_agent case
```typescript
case 'trigger_agent':
  if (data.chatJid && data.prompt) {
    const triggerGroup = registeredGroups[data.chatJid];
    if (triggerGroup) {
      deps.runAgent(triggerGroup, data.prompt, data.chatJid).catch((err) =>
        logger.error({ err, chatJid: data.chatJid }, 'trigger_agent runAgent error'),
      );
    }
  }
  break;
```

### register_webhook_listener case
Creates a listener in the DB, writes snapshot to all group IPC dirs.

### remove_webhook_listener case
Deletes listener from DB, checks ownership (isMain or matching group_folder),
writes updated snapshot to all group IPC dirs.

## Invariants
- All existing IPC task types (schedule_task, pause_task, resume_task, cancel_task,
  refresh_groups, register_group) completely unchanged
- IPC watcher loop and file processing logic unchanged
- Error handling and error directory renaming unchanged
- Per-group IPC namespace isolation unchanged

## Must-keep
- All existing switch cases
- The file scan loop in startIpcWatcher
- Error handling and error directory renaming
- Authorization checks (isMain / sourceGroup ownership)
