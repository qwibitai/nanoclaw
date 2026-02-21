import { EventEmitter } from 'events';

export const monitorBus = new EventEmitter();
monitorBus.setMaxListeners(50);

// Event name constants
export const MONITOR_EVENTS = {
  CONTAINER_START: 'container:start',
  CONTAINER_END: 'container:end',
  MESSAGE_RECEIVED: 'message:received',
  MESSAGE_SENT: 'message:sent',
  QUEUE_CHANGE: 'queue:change',
  TASK_STARTED: 'task:started',
  TASK_COMPLETED: 'task:completed',
  CHANNEL_STATUS: 'channel:status',
} as const;
