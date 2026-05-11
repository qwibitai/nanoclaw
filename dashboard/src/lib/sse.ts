export type EventKind = 'task_event' | 'inbound_message';
type Handler<T = unknown> = (payload: T) => void;

const subscribers = new Map<EventKind, Set<Handler>>();
let es: EventSource | null = null;
let retryDelay = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function dispatchEvent(kind: EventKind, payload: unknown): void {
  const handlers = subscribers.get(kind);
  if (!handlers) return;
  for (const h of handlers) {
    try { h(payload); } catch { /* handler errors must not kill SSE */ }
  }
}

function connect(): void {
  if (stopped) return;
  es = new EventSource('/dashboard/api/events');

  es.addEventListener('task_event', (e: MessageEvent) => {
    retryDelay = 1000;
    try { dispatchEvent('task_event', JSON.parse(e.data as string)); } catch { /* ignore */ }
  });

  es.addEventListener('inbound_message', (e: MessageEvent) => {
    retryDelay = 1000;
    try { dispatchEvent('inbound_message', JSON.parse(e.data as string)); } catch { /* ignore */ }
  });

  es.addEventListener('open', () => { retryDelay = 1000; });

  es.addEventListener('error', () => {
    es?.close();
    es = null;
    if (!stopped) {
      retryTimer = setTimeout(() => {
        retryDelay = Math.min(retryDelay * 2, 30000);
        connect();
      }, retryDelay);
    }
  });
}

export function startSSE(): void {
  stopped = false;
  if (es) return;
  connect();
}

export function stopSSE(): void {
  stopped = true;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  es?.close();
  es = null;
  retryDelay = 1000;
}

export function subscribe<T = unknown>(kind: EventKind, handler: Handler<T>): () => void {
  if (!subscribers.has(kind)) subscribers.set(kind, new Set());
  const set = subscribers.get(kind)!;
  set.add(handler as Handler);
  return () => { set.delete(handler as Handler); };
}
