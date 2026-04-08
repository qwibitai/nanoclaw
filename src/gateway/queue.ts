import type { ChannelType, WorkItem, WorkResult } from '../shared/types.ts';
import { updateSessionAgent, touchSession } from './sessions.ts';

const pending: WorkItem[] = [];
const processing = new Map<string, WorkItem>();
const results = new Map<string, WorkResult>();

type CompletionCallback = (item: WorkItem, result: WorkResult) => void;
const completionCallbacks: CompletionCallback[] = [];

export function onComplete(cb: CompletionCallback): void {
  completionCallbacks.push(cb);
}

export function enqueue(
  sessionId: string,
  channel: ChannelType,
  channelId: string,
  prompt: string,
  agentSessionId?: string,
): WorkItem {
  touchSession(sessionId);
  const item: WorkItem = {
    id: crypto.randomUUID(),
    sessionId,
    channel,
    channelId,
    prompt,
    agentSessionId,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  pending.push(item);
  return item;
}

export function dequeue(): WorkItem | null {
  const item = pending.shift();
  if (!item) return null;
  item.status = 'processing';
  processing.set(item.id, item);
  return item;
}

export function complete(result: WorkResult): void {
  const item = processing.get(result.id);
  if (item) {
    processing.delete(result.id);
    if (result.sessionId) {
      updateSessionAgent(item.sessionId, result.sessionId);
    }
    results.set(item.sessionId, result);

    for (const cb of completionCallbacks) {
      try {
        cb(item, result);
      } catch {
        // Don't let callback errors break the queue
      }
    }
  }
}

export function consumeResult(sessionId: string): WorkResult | null {
  const result = results.get(sessionId);
  if (result) {
    results.delete(sessionId);
  }
  return result ?? null;
}

export function getPendingCount(): number {
  return pending.length;
}

export function getProcessingCount(): number {
  return processing.size;
}
