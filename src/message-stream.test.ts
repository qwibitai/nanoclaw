/**
 * Tests for the MessageStream class used in agent-runner.
 * Verifies the drain() method recovers unconsumed messages.
 */
import { describe, it, expect } from 'vitest';

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Standalone copy of MessageStream from agent-runner/src/index.ts
 * (agent-runner can't import in test context due to SDK dependency)
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  drain(): string[] {
    const texts: string[] = [];
    for (const msg of this.queue) {
      const text = typeof msg.message.content === 'string' ? msg.message.content : '';
      if (text) texts.push(text);
    }
    this.queue.length = 0;
    return texts;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

describe('MessageStream', () => {
  it('drain returns empty array when no messages queued', () => {
    const stream = new MessageStream();
    expect(stream.drain()).toEqual([]);
  });

  it('drain returns unconsumed messages', () => {
    const stream = new MessageStream();
    stream.push('hello');
    stream.push('world');
    const result = stream.drain();
    expect(result).toEqual(['hello', 'world']);
  });

  it('drain clears the queue', () => {
    const stream = new MessageStream();
    stream.push('msg1');
    stream.push('msg2');
    stream.drain();
    expect(stream.drain()).toEqual([]);
  });

  it('drain returns only unconsumed messages after partial read', async () => {
    const stream = new MessageStream();
    stream.push('first');
    stream.push('second');
    stream.push('third');

    // Consume first message via iterator
    const iter = stream[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value?.message.content).toBe('first');

    // Push another while iterator is active
    stream.push('fourth');

    // End the stream so iterator doesn't block
    stream.end();

    // Consume second and third via iterator
    const second = await iter.next();
    expect(second.value?.message.content).toBe('second');

    const third = await iter.next();
    expect(third.value?.message.content).toBe('third');

    const fourth = await iter.next();
    expect(fourth.value?.message.content).toBe('fourth');

    // Iterator should be done
    const done = await iter.next();
    expect(done.done).toBe(true);

    // drain should be empty since all were consumed
    expect(stream.drain()).toEqual([]);
  });

  it('simulates the race: messages pushed but SDK query ends before consuming', async () => {
    const stream = new MessageStream();
    stream.push('initial prompt');

    // Simulate SDK reading the initial prompt
    const iter = stream[Symbol.asyncIterator]();
    const msg = await iter.next();
    expect(msg.value?.message.content).toBe('initial prompt');

    // Simulate pollIpcDuringQuery pushing a message after SDK result
    stream.push('follow-up message from IPC');

    // Simulate SDK ending the query (stops reading from iterator)
    // The follow-up message remains unconsumed in the queue

    // drain() recovers it
    const unconsumed = stream.drain();
    expect(unconsumed).toEqual(['follow-up message from IPC']);
  });

  it('push wakes up blocked iterator', async () => {
    const stream = new MessageStream();

    const results: string[] = [];
    const readPromise = (async () => {
      for await (const msg of stream) {
        results.push(msg.message.content);
      }
    })();

    // Push messages with delays
    stream.push('msg1');
    await new Promise(r => setTimeout(r, 10));
    stream.push('msg2');
    await new Promise(r => setTimeout(r, 10));
    stream.end();

    await readPromise;
    expect(results).toEqual(['msg1', 'msg2']);
  });
});
