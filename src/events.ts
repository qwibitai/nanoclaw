// src/events.ts

/**
 * NanoClaw Event System — Type Definitions
 *
 * All inter-layer communication flows through typed events.
 * Each layer emits and subscribes to events via the EventBus.
 *
 * Event naming: {layer}.{entity}.{action}
 *   layer: message, task, trust, verify, learn, system
 *   entity: what's being acted on
 *   action: what happened
 */

// --- Base event structure ---

export interface NanoClawEvent {
  type: string;
  source: string;
  groupId?: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

// --- Message events ---

export interface MessageInboundEvent extends NanoClawEvent {
  type: 'message.inbound';
  source: 'channel';
  payload: {
    chatJid: string;
    channel: string;
    messageCount: number;
  };
}

export interface MessageOutboundEvent extends NanoClawEvent {
  type: 'message.outbound';
  source: 'router';
  payload: {
    chatJid: string;
    channel: string;
    text: string;
  };
}

// --- Task/Executor events ---

export interface TaskQueuedEvent extends NanoClawEvent {
  type: 'task.queued';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    priority: 'interactive' | 'scheduled' | 'proactive';
    queuePosition: number;
  };
}

export interface TaskStartedEvent extends NanoClawEvent {
  type: 'task.started';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    containerName: string;
    slotIndex: number;
  };
}

export interface TaskCompleteEvent extends NanoClawEvent {
  type: 'task.complete';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    status: 'success' | 'error';
    durationMs: number;
    costUsd?: number;
  };
}

export interface TaskProgressEvent extends NanoClawEvent {
  type: 'task.progress';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    label: string;
  };
}

// --- Warm pool events ---

export interface PoolWarmCreatedEvent extends NanoClawEvent {
  type: 'pool.warm.created';
  source: 'executor';
  payload: {
    containerId: string;
    poolSize: number;
  };
}

export interface PoolWarmUsedEvent extends NanoClawEvent {
  type: 'pool.warm.used';
  source: 'executor';
  payload: {
    containerId: string;
    groupJid: string;
    taskId: string;
  };
}

export interface PoolWarmEvictedEvent extends NanoClawEvent {
  type: 'pool.warm.evicted';
  source: 'executor';
  payload: {
    containerId: string;
    reason: 'idle_timeout' | 'crash' | 'shutdown';
  };
}

// --- System events ---

export interface SystemErrorEvent extends NanoClawEvent {
  type: 'system.error';
  source: string;
  payload: {
    error: string;
    handler: string;
    originalEvent: string;
  };
}

export interface SystemStartupEvent extends NanoClawEvent {
  type: 'system.startup';
  source: 'orchestrator';
  payload: {
    channels: string[];
    groupCount: number;
  };
}

export interface SystemShutdownEvent extends NanoClawEvent {
  type: 'system.shutdown';
  source: 'orchestrator';
  payload: {
    reason: string;
  };
}

// --- Event type map (for type-safe subscriptions) ---

export interface EventMap {
  'message.inbound': MessageInboundEvent;
  'message.outbound': MessageOutboundEvent;
  'task.queued': TaskQueuedEvent;
  'task.started': TaskStartedEvent;
  'task.complete': TaskCompleteEvent;
  'task.progress': TaskProgressEvent;
  'pool.warm.created': PoolWarmCreatedEvent;
  'pool.warm.used': PoolWarmUsedEvent;
  'pool.warm.evicted': PoolWarmEvictedEvent;
  'system.error': SystemErrorEvent;
  'system.startup': SystemStartupEvent;
  'system.shutdown': SystemShutdownEvent;
}

export type EventType = keyof EventMap;
