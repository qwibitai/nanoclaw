import type { Attachment, ChannelType, WorkItem, WorkResult } from '../shared/types.ts';
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
  attachments?: Attachment[],
): WorkItem {
  // Fire-and-forget: touch session in store (async, don't block enqueue)
  touchSession(sessionId).catch(() => {});
  const item: WorkItem = {
    id: crypto.randomUUID(),
    sessionId,
    channel,
    channelId,
    prompt,
    attachments,
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

export function complete(result: WorkResult): boolean {
  const item = processing.get(result.id);
  if (item) {
    processing.delete(result.id);
    if (result.sessionId) {
      // Fire-and-forget: persist agent session ID in store
      updateSessionAgent(item.sessionId, result.sessionId).catch(() => {});
    }
    results.set(result.id, result);

    for (const cb of completionCallbacks) {
      try {
        cb(item, result);
      } catch {
        // Don't let callback errors break the queue
      }
    }
    return true;
  }
  // Item not in processing (gateway may have restarted) — still store the result
  if (result.gatewaySessionId) {
    results.set(result.id, result);
    if (result.sessionId) {
      updateSessionAgent(result.gatewaySessionId, result.sessionId).catch(() => {});
    }
  }
  return false;
}

export function consumeResult(workItemId: string): WorkResult | null {
  const result = results.get(workItemId);
  if (result) {
    results.delete(workItemId);
  }
  return result ?? null;
}

export function getPendingCount(): number {
  return pending.length;
}

export function getProcessingCount(): number {
  return processing.size;
}
