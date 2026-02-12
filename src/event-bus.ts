/**
 * event-bus.ts — Typed event emitter for complaint lifecycle events.
 *
 * Modules emit events here; listeners (e.g. AdminService) react to them.
 * Singleton instance shared across the process.
 */
import { EventEmitter } from 'events';
import { logger } from './logger.js';

export interface ComplaintEvent {
  complaintId: string;
  phone: string;
  category?: string;
  description: string;
  location?: string;
  language: string;
  status: string;
}

export interface StatusChangeEvent {
  complaintId: string;
  phone: string;
  oldStatus: string;
  newStatus: string;
  note?: string;
  updatedBy: string;
}

interface EventMap {
  'complaint:created': [ComplaintEvent];
  'complaint:status-changed': [StatusChangeEvent];
}

class TypedEventEmitter extends EventEmitter {
  on<K extends keyof EventMap>(
    event: K,
    listener: (...args: EventMap[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): boolean {
    const listeners = this.listeners(event);
    let emitted = false;
    for (const listener of listeners) {
      try {
        (listener as (...a: EventMap[K]) => void)(...args);
        emitted = true;
      } catch (err) {
        logger.error({ event, err }, 'Event listener threw an error');
      }
    }
    return emitted;
  }
}

export const eventBus = new TypedEventEmitter();
eventBus.setMaxListeners(20);
