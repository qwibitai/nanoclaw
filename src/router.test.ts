import { describe, it, expect } from 'vitest';

import {
  escapeXml,
  formatMessages,
  formatOutbound,
  routeOutbound,
  findChannel,
  stripInternalTags,
} from './router.js';
import type { Channel } from './types.js';

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands, angle brackets, and quotes', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('returns empty string for falsy input', () => {
    expect(escapeXml('')).toBe('');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  it('formats messages as XML', () => {
    const result = formatMessages(
      [
        {
          id: '1',
          chat_jid: 'g@g.us',
          sender: 'a@s',
          sender_name: 'Alice',
          content: 'hello',
          timestamp: '2024-01-01T00:00:01.000Z',
        },
      ],
      'UTC',
    );
    expect(result).toContain('<messages>');
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('>hello</message>');
  });

  it('escapes XML in sender name and content', () => {
    const result = formatMessages(
      [
        {
          id: '1',
          chat_jid: 'g@g.us',
          sender: 'a@s',
          sender_name: 'A & B',
          content: '<script>alert(1)</script>',
          timestamp: '2024-01-01T00:00:01.000Z',
        },
      ],
      'UTC',
    );
    expect(result).toContain('sender="A &amp; B"');
    expect(result).toContain('&lt;script&gt;');
  });
});

// --- stripInternalTags ---

describe('stripInternalTags', () => {
  it('removes internal tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('removes multiline internal tags', () => {
    expect(
      stripInternalTags('before <internal>\nline1\nline2\n</internal> after'),
    ).toBe('before  after');
  });

  it('returns empty string when only internal content', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });
});

// --- formatOutbound ---

describe('formatOutbound', () => {
  it('strips internal tags from outbound text', () => {
    expect(formatOutbound('visible <internal>hidden</internal> text')).toBe(
      'visible  text',
    );
  });

  it('returns empty string for internal-only text', () => {
    expect(formatOutbound('<internal>only</internal>')).toBe('');
  });
});

// --- routeOutbound ---

describe('routeOutbound', () => {
  function createMockChannel(
    name: string,
    ownsJids: string[],
    connected = true,
  ): Channel {
    return {
      name,
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => connected,
      ownsJid: (jid: string) => ownsJids.includes(jid),
      disconnect: async () => {},
    };
  }

  it('routes to the correct channel', async () => {
    const sent: string[] = [];
    const ch: Channel = {
      ...createMockChannel('whatsapp', ['group@g.us']),
      sendMessage: async (_jid, text) => {
        sent.push(text);
      },
    };
    await routeOutbound([ch], 'group@g.us', 'hello');
    expect(sent).toEqual(['hello']);
  });

  it('throws when no channel owns the JID', () => {
    const ch = createMockChannel('whatsapp', ['group@g.us']);
    expect(() => routeOutbound([ch], 'unknown@g.us', 'hello')).toThrow(
      'No channel for JID',
    );
  });

  it('throws when channel owns JID but is disconnected', () => {
    const ch = createMockChannel('whatsapp', ['group@g.us'], false);
    expect(() => routeOutbound([ch], 'group@g.us', 'hello')).toThrow(
      'No channel for JID',
    );
  });

  it('selects first matching connected channel when multiple exist', async () => {
    const sent: string[] = [];
    const ch1 = createMockChannel('ch1', ['group@g.us'], false);
    const ch2: Channel = {
      ...createMockChannel('ch2', ['group@g.us'], true),
      sendMessage: async (_jid, text) => {
        sent.push(text);
      },
    };
    await routeOutbound([ch1, ch2], 'group@g.us', 'hi');
    expect(sent).toEqual(['hi']);
  });
});

// --- findChannel ---

describe('findChannel', () => {
  it('returns channel that owns the JID', () => {
    const ch: Channel = {
      name: 'telegram',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: (jid) => jid.startsWith('tg:'),
      disconnect: async () => {},
    };
    expect(findChannel([ch], 'tg:123')).toBe(ch);
  });

  it('returns undefined when no channel matches', () => {
    const ch: Channel = {
      name: 'telegram',
      connect: async () => {},
      sendMessage: async () => {},
      isConnected: () => true,
      ownsJid: (jid) => jid.startsWith('tg:'),
      disconnect: async () => {},
    };
    expect(findChannel([ch], 'wa:123')).toBeUndefined();
  });
});
