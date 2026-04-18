import { EventEmitter } from 'events';
import { logger } from './logger.js';
import type {
  EventMap,
  EventType,
  NanoClawEvent,
  SystemErrorEvent,
} from './events.js';

type EventHandler<T extends NanoClawEvent> = (event: T) => void;

export class EventBus {
  private emitter = new EventEmitter();
  private anyHandlers: Array<(event: NanoClawEvent) => void> = [];

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on<K extends EventType>(
    type: K,
    handler: EventHandler<EventMap[K]>,
  ): () => void {
    const wrappedHandler = (event: EventMap[K]) => {
      try {
        handler(event);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          {
            eventType: type,
            handler: handler.name || 'anonymous',
            error: errorMsg,
          },
          'Event handler threw — caught by error boundary',
        );
        // Guard against infinite recursion: don't emit system.error for system.error handlers
        if (type !== 'system.error') {
          const errorEvent: SystemErrorEvent = {
            type: 'system.error',
            source: 'event-bus',
            timestamp: Date.now(),
            payload: {
              error: errorMsg,
              handler: handler.name || 'anonymous',
              originalEvent: type,
            },
          };
          this.emit('system.error', errorEvent);
        }
      }
    };
    this.emitter.on(type, wrappedHandler);
    return () => this.emitter.off(type, wrappedHandler);
  }

  emit<K extends EventType>(type: K, event: EventMap[K]): void {
    logger.debug(
      { eventType: type, source: event.source, groupId: event.groupId },
      'Event emitted',
    );
    for (const handler of this.anyHandlers) {
      try {
        handler(event);
      } catch {
        // Swallow — any-handlers are observability-only
      }
    }
    this.emitter.emit(type, event);
  }

  onAny(handler: (event: NanoClawEvent) => void): () => void {
    this.anyHandlers.push(handler);
    return () => {
      const idx = this.anyHandlers.indexOf(handler);
      if (idx >= 0) this.anyHandlers.splice(idx, 1);
    };
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
    this.anyHandlers = [];
  }
}

export const eventBus = new EventBus();
