/**
 * Scheduling module — one-shot and recurring tasks.
 *
 * Registers:
 *   - Five delivery action handlers: schedule_task, cancel_task, pause_task,
 *     resume_task, update_task. The container's scheduling MCP tools
 *     (container/agent-runner/src/mcp-tools/scheduling.ts) write system
 *     messages with these actions; the host applies them to inbound.db.
 *
 * Host integration points (filled by MODULE-HOOK markers, validated here
 * with the scheduling module shipping inline):
 *   - `src/host-sweep.ts` → MODULE-HOOK:scheduling-recurrence calls
 *     `handleRecurrence` each sweep tick.
 *   - `container/agent-runner/src/poll-loop.ts` → MODULE-HOOK:scheduling-pre-task
 *     runs `applyPreTaskScripts` before the provider call so tasks carrying
 *     a pre-agent script can gate their own execution.
 *
 * No DB migration — tasks are `messages_in` rows with `kind='task'`, so the
 * module piggybacks on the core schema.
 */
import { registerDeliveryAction } from '../../delivery.js';
import {
  handleCancelTask,
  handlePauseTask,
  handleResumeTask,
  handleScheduleTask,
  handleUpdateTask,
} from './actions.js';

registerDeliveryAction('schedule_task', handleScheduleTask);
registerDeliveryAction('cancel_task', handleCancelTask);
registerDeliveryAction('pause_task', handlePauseTask);
registerDeliveryAction('resume_task', handleResumeTask);
registerDeliveryAction('update_task', handleUpdateTask);
