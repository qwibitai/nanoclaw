import { describe, it, expect } from 'vitest';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from './config.js';
import {
  escapeXml,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'group@g.us',
    sender: '123@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles multiple special characters together', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('passes through strings with no special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  it('formats a single message as XML', () => {
    const result = formatMessages([makeMsg()]);
    expect(result).toBe(
      '<messages>\n' +
        '<message sender="Alice" time="2024-01-01T00:00:00.000Z">hello</message>\n' +
        '</messages>',
    );
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender_name: 'Alice',
        content: 'hi',
        timestamp: 't1',
      }),
      makeMsg({ id: '2', sender_name: 'Bob', content: 'hey', timestamp: 't2' }),
    ];
    const result = formatMessages(msgs);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('>hi</message>');
    expect(result).toContain('>hey</message>');
  });

  it('escapes special characters in sender names', () => {
    const result = formatMessages([makeMsg({ sender_name: 'A & B <Co>' })]);
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
  });

  it('escapes special characters in content', () => {
    const result = formatMessages([
      makeMsg({ content: '<script>alert("xss")</script>' }),
    ]);
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('handles empty array', () => {
    const result = formatMessages([]);
    expect(result).toBe('<messages>\n\n</messages>');
  });

  // --- msg-id agnosticism ---

  it('does NOT add msg-id for WhatsApp-style IDs (no channel prefix)', () => {
    const result = formatMessages([makeMsg({ id: 'BAE5D2F9F95C5B08' })]);
    expect(result).not.toContain('msg-id');
  });

  it('adds msg-id for channel-prefixed IDs (signal-<timestamp>)', () => {
    const result = formatMessages([
      makeMsg({ id: 'signal-1709123456', sender: '+15551234567' }),
    ]);
    expect(result).toContain('msg-id="1709123456:+15551234567"');
  });

  it('adds msg-id for arbitrary channel-prefixed IDs (telegram-<id>)', () => {
    const result = formatMessages([
      makeMsg({ id: 'telegram-abc123', sender: 'user42' }),
    ]);
    expect(result).toContain('msg-id="abc123:user42"');
  });

  it('does NOT add msg-id for numeric-only IDs', () => {
    const result = formatMessages([makeMsg({ id: '1234567890' })]);
    expect(result).not.toContain('msg-id');
  });

  it('does NOT add msg-id when sender is empty', () => {
    const result = formatMessages([
      makeMsg({ id: 'signal-1709123456', sender: '' }),
    ]);
    expect(result).not.toContain('msg-id');
  });

  // --- quote / reply-to context ---

  it('includes replying-to attribute when message has a quote', () => {
    const result = formatMessages([
      makeMsg({ quote: { author: 'Bob', text: 'original message' } }),
    ]);
    expect(result).toContain('replying-to="Bob: original message"');
  });

  it('truncates long quotes to 100 chars', () => {
    const longText = 'x'.repeat(150);
    const result = formatMessages([
      makeMsg({ quote: { author: 'Bob', text: longText } }),
    ]);
    expect(result).toContain('replying-to="Bob: ' + 'x'.repeat(100) + '..."');
  });

  // --- attachments ---

  it('includes attachment child elements', () => {
    const result = formatMessages([
      makeMsg({
        attachments: [
          {
            contentType: 'image/jpeg',
            filename: 'photo.jpg',
            hostPath: '/tmp/photo.jpg',
            containerPath: '/workspace/group/photo.jpg',
          },
        ],
      }),
    ]);
    expect(result).toContain('<attachment type="image/jpeg" path="/workspace/group/photo.jpg" filename="photo.jpg" />');
  });

  it('handles attachments without filename', () => {
    const result = formatMessages([
      makeMsg({
        attachments: [
          {
            contentType: 'audio/ogg',
            hostPath: '/tmp/voice.ogg',
            containerPath: '/workspace/group/voice.ogg',
          },
        ],
      }),
    ]);
    expect(result).toContain('<attachment type="audio/ogg" path="/workspace/group/voice.ogg" />');
    expect(result).not.toContain('filename=');
  });

  // --- combined: all features on one message ---

  it('combines msg-id, quote, and attachments on a single message', () => {
    const result = formatMessages([
      makeMsg({
        id: 'discord-99887766',
        sender: 'userX',
        quote: { author: 'Alice', text: 'check this' },
        attachments: [
          {
            contentType: 'image/png',
            filename: 'screenshot.png',
            hostPath: '/tmp/ss.png',
            containerPath: '/workspace/group/ss.png',
          },
        ],
      }),
    ]);
    expect(result).toContain('msg-id="99887766:userX"');
    expect(result).toContain('replying-to="Alice: check this"');
    expect(result).toContain('<attachment type="image/png"');
  });
});

// --- TRIGGER_PATTERN ---

describe('TRIGGER_PATTERN', () => {
  const name = ASSISTANT_NAME;
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();

  it('matches @name at start of message', () => {
    expect(TRIGGER_PATTERN.test(`@${name} hello`)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(TRIGGER_PATTERN.test(`@${lower} hello`)).toBe(true);
    expect(TRIGGER_PATTERN.test(`@${upper} hello`)).toBe(true);
  });

  it('does not match when not at start of message', () => {
    expect(TRIGGER_PATTERN.test(`hello @${name}`)).toBe(false);
  });

  it('does not match partial name like @NameExtra (word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}extra hello`)).toBe(false);
  });

  it('matches with word boundary before apostrophe', () => {
    expect(TRIGGER_PATTERN.test(`@${name}'s thing`)).toBe(true);
  });

  it('matches @name alone (end of string is a word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}`)).toBe(true);
  });

  it('matches with leading whitespace after trim', () => {
    // The actual usage trims before testing: TRIGGER_PATTERN.test(m.content.trim())
    expect(TRIGGER_PATTERN.test(`@${name} hey`.trim())).toBe(true);
  });
});

// --- Outbound formatting (internal tag stripping + prefix) ---

describe('stripInternalTags', () => {
  it('strips single-line internal tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multi-line internal tags', () => {
    expect(
      stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world'),
    ).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(
      stripInternalTags('<internal>a</internal>hello<internal>b</internal>'),
    ).toBe('hello');
  });

  it('returns empty string when text is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });
});

describe('formatOutbound', () => {
  it('returns text with internal tags stripped', () => {
    expect(formatOutbound('hello world')).toBe('hello world');
  });

  it('returns empty string when all text is internal', () => {
    expect(formatOutbound('<internal>hidden</internal>')).toBe('');
  });

  it('strips internal tags from remaining text', () => {
    expect(
      formatOutbound('<internal>thinking</internal>The answer is 42'),
    ).toBe('The answer is 42');
  });
});

// --- Trigger gating with requiresTrigger flag ---

describe('trigger gating (requiresTrigger interaction)', () => {
  // Replicates the exact logic from processGroupMessages and startMessageLoop:
  //   if (!isMainGroup && group.requiresTrigger !== false) { check trigger }
  function shouldRequireTrigger(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
  ): boolean {
    return !isMainGroup && requiresTrigger !== false;
  }

  function shouldProcess(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
    messages: NewMessage[],
  ): boolean {
    if (!shouldRequireTrigger(isMainGroup, requiresTrigger)) return true;
    return messages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
  }

  it('main group always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, undefined, msgs)).toBe(true);
  });

  it('main group processes even with requiresTrigger=true', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, true, msgs)).toBe(true);
  });

  it('non-main group with requiresTrigger=undefined requires trigger (defaults to true)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true requires trigger', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, true, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true processes when trigger present', () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(false, true, msgs)).toBe(true);
  });

  it('non-main group with requiresTrigger=false always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, false, msgs)).toBe(true);
  });
});
