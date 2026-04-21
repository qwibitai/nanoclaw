import { describe, it, expect } from 'vitest';
import { MessageStream } from './message-stream.js';

describe('MessageStream.push', () => {
  it('produces string content when no images are provided', async () => {
    const s = new MessageStream();
    s.push('hello');
    s.end();
    const msg = (await s[Symbol.asyncIterator]().next()).value;
    expect(msg!.message.content).toBe('hello');
  });

  it('produces an array of content blocks when images are provided', async () => {
    const s = new MessageStream();
    s.push('describe this', [
      { mediaType: 'image/jpeg', data: 'AAAA' },
      { mediaType: 'image/png', data: 'BBBB' },
    ]);
    s.end();
    const msg = (await s[Symbol.asyncIterator]().next()).value;
    const content = msg!.message.content as Array<{
      type: string;
      source?: { type: string; media_type: string; data: string };
      text?: string;
    }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
    });
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'BBBB' },
    });
    expect(content[2]).toEqual({ type: 'text', text: 'describe this' });
  });

  it('empty images array is treated as no images (returns string content)', async () => {
    const s = new MessageStream();
    s.push('hello', []);
    s.end();
    const msg = (await s[Symbol.asyncIterator]().next()).value;
    expect(msg!.message.content).toBe('hello');
  });
});
