import { describe, it, expect } from 'vitest';

import {
  validateRelayMessage,
  buildDelivery,
  buildLogEntry,
  formatRelayMessage,
  RelayMessage,
} from './agent-relay.js';

describe('validateRelayMessage', () => {
  const validMsg = {
    id: 'relay-1',
    from: 'main',
    to: 'research',
    content: 'Hello from main',
    timestamp: '2026-02-28T00:00:00Z',
  };

  it('returns null for valid message', () => {
    expect(validateRelayMessage(validMsg)).toBeNull();
  });

  it('returns null for message with replyTo', () => {
    expect(
      validateRelayMessage({ ...validMsg, replyTo: 'relay-0' }),
    ).toBeNull();
  });

  it('rejects non-object', () => {
    expect(validateRelayMessage(null)).toBe('Message must be an object');
    expect(validateRelayMessage('string')).toBe('Message must be an object');
  });

  it('rejects missing id', () => {
    expect(validateRelayMessage({ ...validMsg, id: '' })).toBe(
      'Missing or empty id',
    );
  });

  it('rejects missing from', () => {
    expect(validateRelayMessage({ ...validMsg, from: '' })).toBe(
      'Missing or empty from',
    );
  });

  it('rejects missing to', () => {
    expect(validateRelayMessage({ ...validMsg, to: '' })).toBe(
      'Missing or empty to',
    );
  });

  it('rejects missing content', () => {
    expect(validateRelayMessage({ ...validMsg, content: '' })).toBe(
      'Missing or empty content',
    );
  });

  it('rejects missing timestamp', () => {
    expect(validateRelayMessage({ ...validMsg, timestamp: '' })).toBe(
      'Missing or empty timestamp',
    );
  });

  it('rejects self-send', () => {
    expect(validateRelayMessage({ ...validMsg, to: 'main' })).toBe(
      'Cannot send message to self',
    );
  });
});

describe('buildDelivery', () => {
  it('builds delivered receipt', () => {
    const d = buildDelivery('relay-1', 'delivered');
    expect(d.id).toBe('relay-1');
    expect(d.status).toBe('delivered');
    expect(d.reason).toBeUndefined();
    expect(d.timestamp).toBeTruthy();
  });

  it('builds undeliverable receipt with reason', () => {
    const d = buildDelivery(
      'relay-2',
      'undeliverable',
      'Target not registered',
    );
    expect(d.status).toBe('undeliverable');
    expect(d.reason).toBe('Target not registered');
  });
});

describe('buildLogEntry', () => {
  it('combines message and delivery', () => {
    const msg: RelayMessage = {
      id: 'relay-1',
      from: 'main',
      to: 'research',
      content: 'Do the thing',
      timestamp: '2026-02-28T00:00:00Z',
    };
    const delivery = buildDelivery('relay-1', 'delivered');
    const entry = buildLogEntry(msg, delivery);
    expect(entry.message).toBe(msg);
    expect(entry.delivery).toBe(delivery);
  });
});

describe('formatRelayMessage', () => {
  it('formats basic message', () => {
    const msg: RelayMessage = {
      id: 'relay-1',
      from: 'main',
      to: 'research',
      content: 'Check the logs',
      timestamp: '2026-02-28T00:00:00Z',
    };
    const result = formatRelayMessage(msg);
    expect(result).toContain('[Relay] main → research');
    expect(result).toContain('Check the logs');
  });

  it('includes reply reference', () => {
    const msg: RelayMessage = {
      id: 'relay-2',
      from: 'research',
      to: 'main',
      content: 'Logs look clean',
      replyTo: 'relay-1',
      timestamp: '2026-02-28T00:00:00Z',
    };
    const result = formatRelayMessage(msg);
    expect(result).toContain('(reply to relay-1)');
  });
});
