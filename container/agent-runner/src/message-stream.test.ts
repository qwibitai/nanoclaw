import { describe, it, expect } from 'vitest';
import { MessageStream } from './message-stream.js';

describe('MessageStream', () => {
  /**
   * INVARIANT: MessageStream is an async iterable that yields SDKUserMessage objects
   * pushed into it, and terminates when end() is called.
   */

  it('yields pushed messages in order', async () => {
    const stream = new MessageStream();
    stream.push('first');
    stream.push('second');
    stream.end();

    const messages: string[] = [];
    for await (const msg of stream) {
      messages.push(msg.message.content);
    }
    expect(messages).toEqual(['first', 'second']);
  });

  it('produces correct SDKUserMessage shape', async () => {
    const stream = new MessageStream();
    stream.push('test');
    stream.end();

    for await (const msg of stream) {
      expect(msg.type).toBe('user');
      expect(msg.message.role).toBe('user');
      expect(msg.message.content).toBe('test');
      expect(msg.parent_tool_use_id).toBeNull();
      expect(msg.session_id).toBe('');
    }
  });

  it('waits for pushed messages before yielding', async () => {
    const stream = new MessageStream();
    const messages: string[] = [];

    const consumer = (async () => {
      for await (const msg of stream) {
        messages.push(msg.message.content);
      }
    })();

    // Push after a tick to test async waiting
    await new Promise((r) => setTimeout(r, 10));
    stream.push('delayed');
    stream.end();

    await consumer;
    expect(messages).toEqual(['delayed']);
  });

  it('terminates iteration on end()', async () => {
    const stream = new MessageStream();
    stream.end();

    const messages: string[] = [];
    for await (const msg of stream) {
      messages.push(msg.message.content);
    }
    expect(messages).toEqual([]);
  });
});
