// src/priority-queue.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PriorityQueue, TaskPriority } from './priority-queue.js';

interface TestItem {
  id: string;
  groupJid: string;
}

describe('PriorityQueue', () => {
  let pq: PriorityQueue<TestItem>;

  beforeEach(() => {
    pq = new PriorityQueue();
  });

  it('dequeues interactive before scheduled before proactive', () => {
    pq.enqueue({ id: 'p', groupJid: 'g1' }, 'proactive');
    pq.enqueue({ id: 's', groupJid: 'g2' }, 'scheduled');
    pq.enqueue({ id: 'i', groupJid: 'g3' }, 'interactive');

    expect(pq.dequeue()?.item.id).toBe('i');
    expect(pq.dequeue()?.item.id).toBe('s');
    expect(pq.dequeue()?.item.id).toBe('p');
    expect(pq.dequeue()).toBeNull();
  });

  it('returns null when empty', () => {
    expect(pq.dequeue()).toBeNull();
  });

  it('reports isEmpty correctly', () => {
    expect(pq.isEmpty()).toBe(true);
    pq.enqueue({ id: 'a', groupJid: 'g1' }, 'interactive');
    expect(pq.isEmpty()).toBe(false);
    pq.dequeue();
    expect(pq.isEmpty()).toBe(true);
  });

  it('reports size correctly', () => {
    pq.enqueue({ id: 'a', groupJid: 'g1' }, 'interactive');
    pq.enqueue({ id: 'b', groupJid: 'g2' }, 'scheduled');
    expect(pq.size()).toBe(2);
    pq.dequeue();
    expect(pq.size()).toBe(1);
  });

  it('round-robins within the same priority level', () => {
    // Two groups both enqueue interactive tasks — they should alternate
    pq.enqueue({ id: 'g1-1', groupJid: 'g1' }, 'interactive');
    pq.enqueue({ id: 'g1-2', groupJid: 'g1' }, 'interactive');
    pq.enqueue({ id: 'g2-1', groupJid: 'g2' }, 'interactive');
    pq.enqueue({ id: 'g2-2', groupJid: 'g2' }, 'interactive');

    const order = [
      pq.dequeue()?.item.groupJid,
      pq.dequeue()?.item.groupJid,
      pq.dequeue()?.item.groupJid,
      pq.dequeue()?.item.groupJid,
    ];

    // Each group should appear exactly twice, interleaved
    expect(order[0]).not.toBe(order[1]); // alternates
    expect(order[2]).not.toBe(order[3]); // alternates
  });

  it('round-robin handles single group correctly', () => {
    pq.enqueue({ id: 'a', groupJid: 'g1' }, 'scheduled');
    pq.enqueue({ id: 'b', groupJid: 'g1' }, 'scheduled');
    expect(pq.dequeue()?.item.id).toBe('a');
    expect(pq.dequeue()?.item.id).toBe('b');
  });

  it('removes all entries for a groupJid', () => {
    pq.enqueue({ id: 'a', groupJid: 'g1' }, 'interactive');
    pq.enqueue({ id: 'b', groupJid: 'g2' }, 'interactive');
    pq.enqueue({ id: 'c', groupJid: 'g1' }, 'scheduled');

    pq.removeGroup('g1');
    expect(pq.size()).toBe(1);
    expect(pq.dequeue()?.item.groupJid).toBe('g2');
  });

  it('peeks without removing', () => {
    pq.enqueue({ id: 'a', groupJid: 'g1' }, 'interactive');
    expect(pq.peek()?.item.id).toBe('a');
    expect(pq.size()).toBe(1); // still there
  });

  it('includes priority in dequeue result', () => {
    pq.enqueue({ id: 'a', groupJid: 'g1' }, 'scheduled');
    const result = pq.dequeue();
    expect(result?.priority).toBe('scheduled');
  });
});
