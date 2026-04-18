// src/priority-queue.ts

export type TaskPriority = 'interactive' | 'scheduled' | 'proactive';

const PRIORITY_ORDER: TaskPriority[] = [
  'interactive',
  'scheduled',
  'proactive',
];

interface Entry<T> {
  item: T;
  groupJid: string;
  priority: TaskPriority;
}

interface DequeueResult<T> {
  item: T;
  priority: TaskPriority;
}

/**
 * Three-level priority queue with per-group round-robin fairness within each
 * priority level.
 *
 * Dequeue order:
 *   1. interactive (user messages)
 *   2. scheduled (cron/task-scheduler tasks)
 *   3. proactive (background monitoring tasks)
 *
 * Within each level, groups are served in round-robin order so no single group
 * can starve others at the same priority level.
 */
export class PriorityQueue<T = object> {
  // Per-priority bucket: each bucket is a Map<groupJid, Entry<T>[]>
  // The bucket also maintains a round-robin pointer (lastServedGroup) per
  // priority level so we rotate fairly.
  private buckets: Map<TaskPriority, Map<string, Entry<T>[]>> = new Map(
    PRIORITY_ORDER.map((p) => [p, new Map()]),
  );

  // Round-robin cursor per priority: stores the groupJid that was served last
  private roundRobinCursor: Map<TaskPriority, string | null> = new Map(
    PRIORITY_ORDER.map((p) => [p, null]),
  );

  enqueue(item: T, priority: TaskPriority, groupJid?: string): void {
    // groupJid can come from item or be passed explicitly
    const gid =
      groupJid ??
      (item as unknown as { groupJid?: string }).groupJid ??
      '__global__';
    const bucket = this.buckets.get(priority)!;
    if (!bucket.has(gid)) {
      bucket.set(gid, []);
    }
    bucket.get(gid)!.push({ item, groupJid: gid, priority });
  }

  dequeue(): DequeueResult<T> | null {
    for (const priority of PRIORITY_ORDER) {
      const bucket = this.buckets.get(priority)!;
      if (bucket.size === 0) continue;

      // Round-robin: find the next group after the last-served group
      const groups = Array.from(bucket.keys());
      const lastServed = this.roundRobinCursor.get(priority) ?? null;
      let startIdx = 0;
      if (lastServed !== null) {
        const lastIdx = groups.indexOf(lastServed);
        if (lastIdx >= 0) {
          startIdx = (lastIdx + 1) % groups.length;
        }
      }

      // Find next non-empty group (rotate through all groups)
      for (let i = 0; i < groups.length; i++) {
        const idx = (startIdx + i) % groups.length;
        const gid = groups[idx];
        const entries = bucket.get(gid)!;
        if (entries.length > 0) {
          const entry = entries.shift()!;
          if (entries.length === 0) {
            bucket.delete(gid);
          }
          this.roundRobinCursor.set(priority, gid);
          return { item: entry.item, priority };
        }
      }
    }
    return null;
  }

  peek(): DequeueResult<T> | null {
    for (const priority of PRIORITY_ORDER) {
      const bucket = this.buckets.get(priority)!;
      for (const entries of bucket.values()) {
        if (entries.length > 0) {
          return { item: entries[0].item, priority };
        }
      }
    }
    return null;
  }

  isEmpty(): boolean {
    for (const bucket of this.buckets.values()) {
      if (bucket.size > 0) return false;
    }
    return true;
  }

  size(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) {
      for (const entries of bucket.values()) {
        total += entries.length;
      }
    }
    return total;
  }

  removeGroup(groupJid: string): void {
    for (const bucket of this.buckets.values()) {
      bucket.delete(groupJid);
    }
    // Reset cursors that pointed to this group
    for (const [priority, cursor] of this.roundRobinCursor.entries()) {
      if (cursor === groupJid) {
        this.roundRobinCursor.set(priority, null);
      }
    }
  }
}
