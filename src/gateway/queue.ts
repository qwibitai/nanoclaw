import type { WorkItem, WorkResult } from '../shared/types.ts';

const pending: WorkItem[] = [];
const processing = new Map<string, WorkItem>();
const results = new Map<string, WorkResult>();
const sessions = new Map<string, string>();

export function enqueue(
  groupId: string,
  channel: string,
  prompt: string,
): WorkItem {
  const item: WorkItem = {
    id: crypto.randomUUID(),
    groupId,
    channel,
    prompt,
    sessionId: sessions.get(groupId),
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
      sessions.set(item.groupId, result.sessionId);
    }
    results.set(item.groupId, result);
  }
}

export function consumeResult(groupId: string): WorkResult | null {
  const result = results.get(groupId);
  if (result) {
    results.delete(groupId);
  }
  return result ?? null;
}

export function getPendingCount(): number {
  return pending.length;
}

export function getProcessingCount(): number {
  return processing.size;
}
