/**
 * Typed event bus for NanoClaw lifecycle events.
 *
 * Wraps Node.js EventEmitter with typed emit/on/once/off methods.
 * Listener errors are caught internally — a broken listener never crashes
 * the orchestrator.
 */
import { EventEmitter } from 'events';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Event payload interfaces
// ---------------------------------------------------------------------------

export interface ContainerSpawnedEvent {
  timestamp: string;
  groupFolder: string;
  containerName: string;
  isMain: boolean;
  isScheduledTask: boolean;
}

export interface ContainerOutputEvent {
  timestamp: string;
  groupFolder: string;
  chatJid: string;
  result: string | null;
  status: 'success' | 'error';
  newSessionId?: string;
}

export interface ContainerClosedEvent {
  timestamp: string;
  groupFolder: string;
  containerName: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  hadOutput: boolean;
}

export interface ContainerIdleEvent {
  timestamp: string;
  groupFolder: string;
  chatJid: string;
}

export interface AgentInvokedEvent {
  timestamp: string;
  groupFolder: string;
  chatJid: string;
  messageCount: number;
  hasSession: boolean;
}

export interface AgentCompletedEvent {
  timestamp: string;
  groupFolder: string;
  chatJid: string;
  status: 'success' | 'error';
  durationMs: number;
}

export interface SessionClearedEvent {
  timestamp: string;
  groupFolder: string;
  reason: string;
}

export interface TaskExecutedEvent {
  timestamp: string;
  taskId: string;
  status: 'success' | 'error';
  durationMs: number;
  result: string | null;
}

export interface GroupRegisteredEvent {
  timestamp: string;
  jid: string;
  name: string;
  folder: string;
}

export interface IpcProcessedEvent {
  timestamp: string;
  sourceGroup: string;
  type: string;
  authorized: boolean;
}

export interface QueueRetryScheduledEvent {
  timestamp: string;
  groupJid: string;
  retryCount: number;
  delayMs: number;
}

export interface QueueMaxRetriesEvent {
  timestamp: string;
  groupJid: string;
  retryCount: number;
}

export interface SystemShutdownEvent {
  timestamp: string;
  signal: string;
  activeContainers: number;
}

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

export interface NanoClawEvents {
  'container:spawned': ContainerSpawnedEvent;
  'container:output': ContainerOutputEvent;
  'container:closed': ContainerClosedEvent;
  'container:idle': ContainerIdleEvent;
  'agent:invoked': AgentInvokedEvent;
  'agent:completed': AgentCompletedEvent;
  'session:cleared': SessionClearedEvent;
  'task:executed': TaskExecutedEvent;
  'group:registered': GroupRegisteredEvent;
  'ipc:processed': IpcProcessedEvent;
  'queue:retry-scheduled': QueueRetryScheduledEvent;
  'queue:max-retries': QueueMaxRetriesEvent;
  'system:shutdown': SystemShutdownEvent;
}

// ---------------------------------------------------------------------------
// EventBus class
// ---------------------------------------------------------------------------

export class EventBus {
  private emitter = new EventEmitter();
  // Track original → wrapped so off() can remove the correct listener.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wrappedListeners = new Map<Function, Function>();

  constructor() {
    // Prevent Node's default MaxListenersExceededWarning.
    // We expect many listeners across subsystems.
    this.emitter.setMaxListeners(50);
  }

  emit<K extends keyof NanoClawEvents>(event: K, payload: NanoClawEvents[K]): void {
    try {
      this.emitter.emit(event, payload);
    } catch (err) {
      logger.error({ event, err }, 'Unhandled error emitting event');
    }
  }

  on<K extends keyof NanoClawEvents>(
    event: K,
    listener: (payload: NanoClawEvents[K]) => void,
  ): void {
    const wrapped = this.wrapListener(event, listener);
    this.wrappedListeners.set(listener, wrapped);
    this.emitter.on(event, wrapped);
  }

  once<K extends keyof NanoClawEvents>(
    event: K,
    listener: (payload: NanoClawEvents[K]) => void,
  ): void {
    const wrapped = this.wrapListener(event, listener);
    this.wrappedListeners.set(listener, wrapped);
    this.emitter.once(event, wrapped);
  }

  off<K extends keyof NanoClawEvents>(
    event: K,
    listener: (payload: NanoClawEvents[K]) => void,
  ): void {
    const wrapped = this.wrappedListeners.get(listener);
    if (wrapped) {
      this.emitter.off(event, wrapped as (...args: unknown[]) => void);
      this.wrappedListeners.delete(listener);
    }
  }

  removeAllListeners(event?: keyof NanoClawEvents): void {
    if (event) {
      this.emitter.removeAllListeners(event);
      // Per-event removal: don't clear the entire map. Dangling entries
      // for this event are harmless — off() would call emitter.off() with
      // a function already removed, which is a no-op.
    } else {
      this.emitter.removeAllListeners();
      this.wrappedListeners.clear();
    }
  }

  listenerCount(event: keyof NanoClawEvents): number {
    return this.emitter.listenerCount(event);
  }

  private wrapListener<K extends keyof NanoClawEvents>(
    event: K,
    listener: (payload: NanoClawEvents[K]) => void,
  ): (payload: NanoClawEvents[K]) => void {
    return (payload: NanoClawEvents[K]) => {
      try {
        listener(payload);
      } catch (err) {
        logger.error({ event, err }, 'Event listener error (isolated)');
      }
    };
  }
}
