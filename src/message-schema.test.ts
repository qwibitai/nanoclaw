import { describe, it, expect } from 'vitest';
import { formatMessages, formatMessagesStructured } from './router.js';
import { NewMessage, StructuredMessage, ContentBlock } from './types.js';

function makeNewMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-001',
    chat_jid: 'group@g.us',
    sender: '123@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'Hello world',
    timestamp: '2024-01-15T10:30:00.000Z',
    is_from_me: false,
    ...overrides,
  };
}

// --- Structured Message Schema Tests ---

describe('formatMessagesStructured', () => {
  it('converts a single NewMessage to StructuredMessage', () => {
    const messages = [makeNewMessage()];
    const result = formatMessagesStructured(messages, 'UTC');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'msg-001',
      role: 'user',
      timestamp: '2024-01-15T10:30:00.000Z',
      sender_name: 'Alice',
    });
    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0]).toMatchObject({
      type: 'text',
      text: 'Hello world',
    });
  });

  it('maps is_from_me=true to assistant role', () => {
    const messages = [makeNewMessage({ is_from_me: true })];
    const result = formatMessagesStructured(messages, 'UTC');

    expect(result[0].role).toBe('assistant');
  });

  it('maps is_from_me=false to user role', () => {
    const messages = [makeNewMessage({ is_from_me: false })];
    const result = formatMessagesStructured(messages, 'UTC');

    expect(result[0].role).toBe('user');
  });

  it('maps is_from_me=undefined to user role', () => {
    const messages = [makeNewMessage({ is_from_me: undefined })];
    const result = formatMessagesStructured(messages, 'UTC');

    expect(result[0].role).toBe('user');
  });

  it('preserves stable IDs for replay harness', () => {
    const messages = [
      makeNewMessage({ id: 'stable-id-123' }),
      makeNewMessage({ id: 'stable-id-456' }),
    ];
    const result = formatMessagesStructured(messages, 'UTC');

    expect(result[0].id).toBe('stable-id-123');
    expect(result[1].id).toBe('stable-id-456');
  });

  it('preserves timestamps for replay harness', () => {
    const messages = [
      makeNewMessage({ timestamp: '2024-01-15T10:00:00.000Z' }),
      makeNewMessage({ timestamp: '2024-01-15T10:30:00.000Z' }),
    ];
    const result = formatMessagesStructured(messages, 'UTC');

    expect(result[0].timestamp).toBe('2024-01-15T10:00:00.000Z');
    expect(result[1].timestamp).toBe('2024-01-15T10:30:00.000Z');
  });

  it('maintains message order', () => {
    const messages = [
      makeNewMessage({ id: '1', content: 'First' }),
      makeNewMessage({ id: '2', content: 'Second' }),
      makeNewMessage({ id: '3', content: 'Third' }),
    ];
    const result = formatMessagesStructured(messages, 'UTC');

    expect(result.map((m) => m.id)).toEqual(['1', '2', '3']);
    expect(result.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
  });

  it('preserves sender_name for user context', () => {
    const messages = [makeNewMessage({ sender_name: 'Bob Smith' })];
    const result = formatMessagesStructured(messages, 'UTC');

    expect(result[0].sender_name).toBe('Bob Smith');
  });

  it('handles empty content', () => {
    const messages = [makeNewMessage({ content: '' })];
    const result = formatMessagesStructured(messages, 'UTC');

    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0]).toMatchObject({
      type: 'text',
      text: '',
    });
  });

  it('handles special characters in content', () => {
    const messages = [
      makeNewMessage({
        content: 'Hello <world> & "friends"',
      }),
    ];
    const result = formatMessagesStructured(messages, 'UTC');

    expect((result[0].content[0] as { text: string }).text).toBe(
      'Hello <world> & "friends"',
    );
  });

  it('returns empty array for empty input', () => {
    const result = formatMessagesStructured([], 'UTC');

    expect(result).toEqual([]);
  });
});

// --- Content Block Schema Tests ---

describe('ContentBlock schema', () => {
  it('supports text content blocks', () => {
    const block: ContentBlock = { type: 'text', text: 'Hello' };
    expect(block.type).toBe('text');
    expect(block.text).toBe('Hello');
  });

  it('supports attachment content blocks (reserved for future)', () => {
    const block: ContentBlock = {
      type: 'attachment',
      filename: 'document.pdf',
      mimeType: 'application/pdf',
      size: 1024,
    };
    expect(block.type).toBe('attachment');
    expect(block.filename).toBe('document.pdf');
  });
});

// --- Round-trip Serialization Tests ---

describe('round-trip serialization', () => {
  it('serializes and deserializes StructuredMessage correctly', () => {
    const original: StructuredMessage = {
      id: 'msg-001',
      role: 'user',
      content: [{ type: 'text', text: 'Hello world' }],
      timestamp: '2024-01-15T10:30:00.000Z',
      sender_name: 'Alice',
    };

    const serialized = JSON.stringify(original);
    const deserialized: StructuredMessage = JSON.parse(serialized);

    expect(deserialized).toEqual(original);
  });

  it('serializes array of messages stably', () => {
    const messages: StructuredMessage[] = [
      {
        id: 'msg-001',
        role: 'user',
        content: [{ type: 'text', text: 'First' }],
        timestamp: '2024-01-15T10:00:00.000Z',
        sender_name: 'Alice',
      },
      {
        id: 'msg-002',
        role: 'assistant',
        content: [{ type: 'text', text: 'Second' }],
        timestamp: '2024-01-15T10:01:00.000Z',
      },
    ];

    const serialized = JSON.stringify(messages);
    const deserialized: StructuredMessage[] = JSON.parse(serialized);

    expect(deserialized).toEqual(messages);
    expect(deserialized).toHaveLength(2);
    expect(deserialized[0].role).toBe('user');
    expect(deserialized[1].role).toBe('assistant');
  });

  it('maintains stable serialization for replay harness', () => {
    const message: StructuredMessage = {
      id: 'stable-replay-id',
      role: 'user',
      content: [{ type: 'text', text: 'Test message' }],
      timestamp: '2024-01-15T10:30:00.000Z',
      sender_name: 'Test User',
    };

    // Serialize multiple times should produce same result
    const serialized1 = JSON.stringify(message);
    const serialized2 = JSON.stringify(message);

    expect(serialized1).toBe(serialized2);
    expect(serialized1).toContain('stable-replay-id');
    expect(serialized1).toContain('2024-01-15T10:30:00.000Z');
  });
});

// --- Role Mapping Tests ---

describe('role mapping', () => {
  it('correctly maps mixed user and assistant messages', () => {
    const messages = [
      makeNewMessage({ id: '1', is_from_me: false, content: 'User message 1' }),
      makeNewMessage({
        id: '2',
        is_from_me: true,
        content: 'Assistant reply 1',
      }),
      makeNewMessage({ id: '3', is_from_me: false, content: 'User message 2' }),
      makeNewMessage({
        id: '4',
        is_from_me: true,
        content: 'Assistant reply 2',
      }),
    ];

    const result = formatMessagesStructured(messages, 'UTC');

    expect(result.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });
});

// --- Backward Compatibility Tests ---

describe('backward compatibility', () => {
  it('formatMessagesStructured does not affect existing XML format', () => {
    const messages = [makeNewMessage({ content: 'Test' })];
    const xmlResult = formatMessages(messages, 'UTC');

    expect(xmlResult).toContain('Test');
    expect(xmlResult).toContain('<messages>');
    expect(xmlResult).toContain('</message>');
  });
});
