# IPC Task Type Contract

Reference table for all IPC message types handled by NanoClaw's IPC system.

Messages are written as JSON files to `data/ipc/{groupFolder}/messages/` or `data/ipc/{groupFolder}/tasks/` and processed by the IPC watcher (`src/ipc.ts`).

## Message Types

| Type | Handler | Required Fields | Authorization |
|------|---------|----------------|---------------|
| `message` | `message-handler.ts` | `chatJid`, `text` | Main group: any target. Non-main: own group's JID only. |
| `feedback` | `feedback-handler.ts` | `feedbackType` (`bug` \| `feature`), `title`, `description` | Any group. Optional: `email`. |
| `schedule_task` | `task-handler.ts` | `prompt`, `schedule_type` (`cron` \| `interval` \| `once`), `schedule_value`, `targetJid` | Main group: any target. Non-main: own group only. Optional: `taskId`, `context_mode` (`group` \| `isolated`). |
| `pause_task` | `task-handler.ts` | `taskId` | Main group: any task. Non-main: own group's tasks only. |
| `resume_task` | `task-handler.ts` | `taskId` | Main group: any task. Non-main: own group's tasks only. |
| `cancel_task` | `task-handler.ts` | `taskId` | Main group: any task. Non-main: own group's tasks only. |
| `update_task` | `task-handler.ts` | `taskId` | Main group: any task. Non-main: own group's tasks only. Optional: `prompt`, `schedule_type`, `schedule_value`. |
| `refresh_groups` | `task-handler.ts` | _(none)_ | Main group only. |
| `register_group` | `task-handler.ts` | `jid`, `name`, `folder`, `trigger` | Main group only. Folder name must pass `isValidGroupFolder()` check. Optional: `requiresTrigger`, `containerConfig`. |

## File Routing

- Files in `data/ipc/{group}/messages/` are dispatched to the message handler.
- Files in `data/ipc/{group}/tasks/` are dispatched to the task handler; the `feedback` type is routed to the feedback handler based on the `type` field.
- Failed files are moved to `data/ipc/errors/` (auto-cleaned after 7 days).
