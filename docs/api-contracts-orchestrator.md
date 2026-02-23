# NanoClaw — API Contracts: Orchestrator

## Overview

The orchestrator does not expose an HTTP API. Its "API surface" consists of three layers:

1. **Container I/O Protocol** — stdin/stdout JSON contract between the orchestrator and agent containers
2. **IPC Filesystem Protocol** — JSON files written by containers to communicate back to the orchestrator
3. **WhatsApp Message Protocol** — trigger pattern and message routing rules

---

## 1. Container I/O Protocol

### Input: `ContainerInput` (stdin → container)

The orchestrator spawns a container and writes a single JSON object to stdin:

```typescript
interface ContainerInput {
  messages: FormattedMessage[];    // Conversation history as XML-formatted strings
  groupFolder: string;             // Group folder name (e.g. "main")
  chatJid: string;                 // WhatsApp JID of the chat
  assistantName: string;           // Trigger name (e.g. "Andy")
  tasksSnapshot?: string;          // JSON of scheduled tasks for this group
  groupsSnapshot?: string;         // JSON of all registered groups
  isTask?: boolean;                // true if invoked by scheduler (not a user message)
  taskContext?: string;            // Task prompt (when isTask=true)
}
```

**Message format** — each entry in `messages[]` is an XML-encoded string:
```xml
<message id="MSG_ID" timestamp="ISO_TS" sender="DISPLAY_NAME" role="user|assistant">
MESSAGE TEXT
</message>
```

Bot messages are filtered out (excluded from context). Internal tags are stripped from content before delivery.

### Output: Streaming response (stdout → orchestrator)

The container writes responses wrapped in sentinel markers:

```
OUTPUT_START_MARKER
<response text goes here, may span multiple lines>
OUTPUT_END_MARKER
```

- Multiple `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` pairs may appear (one per agent turn)
- Each pair is collected and the text is sent as a WhatsApp message
- Partial output before `OUTPUT_END_MARKER` is buffered

### Signals

| Signal | Description |
|--------|-------------|
| `stdin close` | Sent by `GroupQueue.closeStdin()` after all queued messages are flushed to the container |
| `SIGTERM` | Sent when `stopContainer()` is called (timeout or shutdown) |

---

## 2. IPC Filesystem Protocol

Containers write JSON files to `data/ipc/{groupFolder}/` to request orchestrator actions. The IPC watcher polls every 1 second.

### Directory layout

```
data/ipc/{groupFolder}/
├── messages/     ← Outbound messages to send (read by watcher)
├── tasks/        ← Task management requests (read by watcher)
└── input/        ← Inbound messages for long-running containers (written by watcher)
```

### Message IPC: `data/ipc/{groupFolder}/messages/{filename}.json`

Triggers the orchestrator to send a message to the group's WhatsApp chat.

```typescript
interface IpcMessage {
  type: "message";
  chatJid: string;      // Target JID (must match group's registered JID)
  text: string;         // Message text to send
  timestamp: string;    // ISO timestamp
}
```

**Authorization:** `chatJid` must match the registered group's `chat_jid`. Cross-group messaging is rejected.

### Task IPC: `data/ipc/{groupFolder}/tasks/{filename}.json`

```typescript
// schedule_task
interface IpcScheduleTask {
  type: "schedule_task";
  groupFolder: string;
  chatJid: string;
  prompt: string;
  scheduleType: "cron" | "interval" | "once";
  scheduleValue: string;      // Cron expr / ms interval / ISO timestamp
  contextMode: "group" | "isolated";
}

// pause_task / resume_task / cancel_task
interface IpcTaskControl {
  type: "pause_task" | "resume_task" | "cancel_task";
  taskId: string;
  groupFolder: string;
}

// refresh_groups — reload registered groups from DB
interface IpcRefreshGroups {
  type: "refresh_groups";
  groupFolder: string;
}

// register_group — register a new group on the fly
interface IpcRegisterGroup {
  type: "register_group";
  jid: string;
  name: string;
  folder: string;
  triggerPattern: string;
  requiresTrigger: boolean;
  assistantName?: string;
}
```

**Authorization:** All task IPC requests must have `groupFolder` matching the owning group. `register_group` is only allowed from pre-authorized folders.

### Input IPC: `data/ipc/{groupFolder}/input/{filename}.json`

Written by the orchestrator to deliver follow-up messages to a running container (multi-turn conversations while the container is still processing).

```typescript
interface IpcInputMessage {
  type: "message";
  content: string;    // New message text from user
}
```

A special sentinel `{ type: "_close" }` signals the container to stop reading input.

---

## 3. MCP Tool Definitions

Exposed by `ipc-mcp-stdio.ts` inside the container. The agent SDK invokes these as MCP tools.

### `send_message`

Send a message to the group's WhatsApp chat.

**Input schema:**
```json
{
  "text": { "type": "string", "description": "Message text to send" }
}
```

**Behavior:** Writes `data/ipc/{groupFolder}/messages/{timestamp}.json`

---

### `schedule_task`

Schedule a recurring or one-time task.

**Input schema:**
```json
{
  "prompt":        { "type": "string" },
  "schedule_type": { "type": "string", "enum": ["cron", "interval", "once"] },
  "schedule_value":{ "type": "string", "description": "Cron expr / ms interval / ISO timestamp" },
  "context_mode":  { "type": "string", "enum": ["group", "isolated"], "default": "group" }
}
```

**Behavior:** Writes `data/ipc/{groupFolder}/tasks/{timestamp}.json` with `type: "schedule_task"`

---

### `list_tasks`

List all scheduled tasks for the current group.

**Input schema:** `{}` (no parameters)

**Returns:** JSON array of `ScheduledTask` objects from the snapshot file.

---

### `pause_task`

Pause a scheduled task.

**Input schema:**
```json
{ "task_id": { "type": "string" } }
```

---

### `resume_task`

Resume a paused task.

**Input schema:**
```json
{ "task_id": { "type": "string" } }
```

---

### `cancel_task`

Cancel and delete a scheduled task.

**Input schema:**
```json
{ "task_id": { "type": "string" } }
```

---

### `register_group`

Register a new WhatsApp group for monitoring (admin use only).

**Input schema:**
```json
{
  "jid":              { "type": "string", "description": "WhatsApp JID" },
  "name":             { "type": "string" },
  "folder":           { "type": "string", "description": "Folder name under groups/" },
  "trigger_pattern":  { "type": "string", "description": "Trigger word, e.g. @Andy" },
  "requires_trigger": { "type": "boolean" },
  "assistant_name":   { "type": "string", "optional": true }
}
```

---

## 4. WhatsApp Message Protocol

### Trigger Pattern

Each registered group has a `trigger_pattern` (regex). The default is `^@{ASSISTANT_NAME}\b`.

| `requires_trigger` | Behavior |
|--------------------|----------|
| `1` | Only messages matching `trigger_pattern` are forwarded to the agent |
| `0` | All messages are forwarded |

### Message Filtering

Messages are filtered/excluded from agent context:
- `is_bot_message = 1` — messages sent by the assistant are excluded
- Only messages within the poll window are forwarded (cursor-based via `last_agent_timestamp`)

### Typing Indicator

The orchestrator sends a typing composing indicator to WhatsApp before dispatching to the container, and clears it when the response is ready.

### Multi-message Batching

If new messages arrive while a container is running for the same group, they are queued in `GroupQueue` and fed to the running container via the IPC input directory, rather than spawning a new container.
