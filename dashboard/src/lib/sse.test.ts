import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startSSE, stopSSE, subscribe } from './sse.ts';

// Minimal EventSource mock
class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  closed = false;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  emit(type: string, data: unknown) {
    const handlers = this.listeners[type] ?? [];
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const h of handlers) h(event);
  }

  close() { this.closed = true; }
}

describe('sse', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    stopSSE();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('test_sse_subscribe_unsubscribe', () => {
    it('routes events to subscribers and respects unsubscribe', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      startSSE();
      const unsub1 = subscribe('task_event', handler1);
      subscribe('task_event', handler2);

      const es = MockEventSource.instances[0];
      es.emit('task_event', { kind: 'admit', task_id: 'spawn-1' });
      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();

      unsub1();
      es.emit('task_event', { kind: 'update', task_id: 'spawn-1' });
      expect(handler1).toHaveBeenCalledOnce(); // no new calls
      expect(handler2).toHaveBeenCalledTimes(2);
    });
  });

  describe('test_sse_reconnect_with_backoff', () => {
    it('reconnects with exponential backoff up to 30s', () => {
      vi.useFakeTimers();

      startSSE();
      expect(MockEventSource.instances).toHaveLength(1);

      // Simulate disconnect
      const es1 = MockEventSource.instances[0];
      es1.emit('error', {});

      // After 1s, should reconnect
      vi.advanceTimersByTime(1000);
      expect(MockEventSource.instances).toHaveLength(2);

      // Simulate second disconnect
      const es2 = MockEventSource.instances[1];
      es2.emit('error', {});

      // After 2s, third connection
      vi.advanceTimersByTime(2000);
      expect(MockEventSource.instances).toHaveLength(3);

      // Simulate third disconnect — should schedule at 4s
      const es3 = MockEventSource.instances[2];
      es3.emit('error', {});

      vi.advanceTimersByTime(4000);
      expect(MockEventSource.instances).toHaveLength(4);
    });
  });

  describe('single EventSource instance', () => {
    it('does not create multiple instances on multiple startSSE calls', () => {
      startSSE();
      startSSE();
      startSSE();
      expect(MockEventSource.instances).toHaveLength(1);
    });

    it('shared connection — multiple subscribes use one instance', () => {
      startSSE();
      subscribe('task_event', vi.fn());
      subscribe('task_event', vi.fn());
      subscribe('inbound_message', vi.fn());
      expect(MockEventSource.instances).toHaveLength(1);
    });
  });
});
