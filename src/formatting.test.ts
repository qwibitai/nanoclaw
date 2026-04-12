import { describe, it, expect } from 'vitest';

import { buildTriggerPattern, getTriggerPattern } from './config.js';
import {
  escapeXml,
  extractImages,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import { NewMessage, RegisteredGroup } from './types.js';

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
  const TZ = 'UTC';

  it('formats a single message as XML with context header', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).toContain('timezone="UTC"');
    expect(result).toContain('current_time="');
    expect(result).toContain('<message sender="Alice"');
    expect(result).toContain('>hello</message>');
    expect(result).toContain('Jan 1, 2024');
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender_name: 'Alice',
        content: 'hi',
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
      makeMsg({
        id: '2',
        sender_name: 'Bob',
        content: 'hey',
        timestamp: '2024-01-01T01:00:00.000Z',
      }),
    ];
    const result = formatMessages(msgs, TZ);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('>hi</message>');
    expect(result).toContain('>hey</message>');
  });

  it('escapes special characters in sender names', () => {
    const result = formatMessages([makeMsg({ sender_name: 'A & B <Co>' })], TZ);
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
  });

  it('escapes special characters in content', () => {
    const result = formatMessages(
      [makeMsg({ content: '<script>alert("xss")</script>' })],
      TZ,
    );
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('handles empty array', () => {
    const result = formatMessages([], TZ);
    expect(result).toContain('timezone="UTC"');
    expect(result).toContain('<messages>\n\n</messages>');
  });

  it('renders reply context as quoted_message element', () => {
    const result = formatMessages(
      [
        makeMsg({
          content: 'Yes, on my way!',
          reply_to_message_id: '42',
          reply_to_message_content: 'Are you coming tonight?',
          reply_to_sender_name: 'Bob',
        }),
      ],
      TZ,
    );
    expect(result).toContain('reply_to="42"');
    expect(result).toContain(
      '<quoted_message from="Bob">Are you coming tonight?</quoted_message>',
    );
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('omits reply attributes when no reply context', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('omits quoted_message when content is missing but id is present', () => {
    const result = formatMessages(
      [
        makeMsg({
          reply_to_message_id: '42',
          reply_to_sender_name: 'Bob',
        }),
      ],
      TZ,
    );
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('escapes special characters in reply context', () => {
    const result = formatMessages(
      [
        makeMsg({
          reply_to_message_id: '1',
          reply_to_message_content: '<script>alert("xss")</script>',
          reply_to_sender_name: 'A & B',
        }),
      ],
      TZ,
    );
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('converts timestamps to local time for given timezone', () => {
    // 2024-01-01T18:30:00Z in America/New_York (EST) = 1:30 PM
    const result = formatMessages(
      [makeMsg({ timestamp: '2024-01-01T18:30:00.000Z' })],
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('timezone="America/New_York"');
  });
  it('includes <notice> when group has pendingModelNotice', () => {
    const group = {
      name: 'test',
      folder: 'test',
      trigger: '@test',
      added_at: '2024-01-01',
      pendingModelNotice: '[model has switched from sonnet to opus]',
    } as RegisteredGroup;
    const result = formatMessages([makeMsg()], TZ, group);
    expect(result).toContain(
      '<notice>[model has switched from sonnet to opus]</notice>',
    );
    expect(result).toContain('<message sender="Alice"');
  });

  it('clears pendingModelNotice after consumption', () => {
    const group = {
      name: 'test',
      folder: 'test',
      trigger: '@test',
      added_at: '2024-01-01',
      pendingModelNotice: '[model has switched from sonnet to opus]',
    } as RegisteredGroup;
    formatMessages([makeMsg()], TZ, group);
    expect(group.pendingModelNotice).toBeUndefined();
  });

  it('does not include <notice> on second call', () => {
    const group = {
      name: 'test',
      folder: 'test',
      trigger: '@test',
      added_at: '2024-01-01',
      pendingModelNotice: '[model has switched from sonnet to opus]',
    } as RegisteredGroup;
    formatMessages([makeMsg()], TZ, group);
    const result = formatMessages([makeMsg()], TZ, group);
    expect(result).not.toContain('<notice>');
  });

  it('does not include <notice> when no group is passed', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).not.toContain('<notice>');
  });

  it('does not include <notice> when group has no pending notice', () => {
    const group = {
      name: 'test',
      folder: 'test',
      trigger: '@test',
      added_at: '2024-01-01',
    } as RegisteredGroup;
    const result = formatMessages([makeMsg()], TZ, group);
    expect(result).not.toContain('<notice>');
  });
});

// --- buildTriggerPattern ---

describe('buildTriggerPattern', () => {
  const pattern = buildTriggerPattern('@Andy');

  it('matches @name at start of message', () => {
    expect(pattern.test('@Andy hello')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(pattern.test('@andy hello')).toBe(true);
    expect(pattern.test('@ANDY hello')).toBe(true);
  });

  it('does not match when not at start of message', () => {
    expect(pattern.test('hello @Andy')).toBe(false);
  });

  it('does not match partial name like @NameExtra (word boundary)', () => {
    expect(pattern.test('@Andyextra hello')).toBe(false);
  });

  it('matches with word boundary before apostrophe', () => {
    expect(pattern.test("@Andy's thing")).toBe(true);
  });

  it('matches @name alone (end of string is a word boundary)', () => {
    expect(pattern.test('@Andy')).toBe(true);
  });

  it('matches with leading whitespace after trim', () => {
    expect(pattern.test('@Andy hey'.trim())).toBe(true);
  });
});

describe('getTriggerPattern', () => {
  it('uses the configured per-group trigger when provided', () => {
    const pattern = getTriggerPattern('@Claw');

    expect(pattern.test('@Claw hello')).toBe(true);
    expect(pattern.test('@Andy hello')).toBe(false);
  });

  it('falls back to the default trigger when group trigger is missing', () => {
    const pattern = getTriggerPattern(undefined);

    // Falls back to DEFAULT_TRIGGER which uses ASSISTANT_NAME from env;
    // just verify a pattern is returned and works as a regex
    expect(pattern).toBeInstanceOf(RegExp);
  });

  it('treats regex characters in custom triggers literally', () => {
    const pattern = getTriggerPattern('@C.L.A.U.D.E');

    expect(pattern.test('@C.L.A.U.D.E hello')).toBe(true);
    expect(pattern.test('@CXLXAUXDXE hello')).toBe(false);
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

  // Streaming leak prevention tests (issue #29)
  it('strips unclosed <internal> tag to end of string', () => {
    expect(stripInternalTags('hello <internal>thinking...')).toBe('hello');
  });

  it('strips incomplete opening tag fragment <int', () => {
    expect(stripInternalTags('hello <int')).toBe('hello');
  });

  it('strips incomplete opening tag fragment <intern', () => {
    expect(stripInternalTags('hello <intern')).toBe('hello');
  });

  it('strips incomplete opening tag fragment <internal', () => {
    expect(stripInternalTags('hello <internal')).toBe('hello');
  });

  it('strips complete pair + trailing unclosed tag', () => {
    expect(stripInternalTags('<internal>a</internal>hello<internal>b')).toBe(
      'hello',
    );
  });

  it('returns empty string when text is only unclosed internal tag', () => {
    expect(stripInternalTags('<internal>only this')).toBe('');
  });

  it('does not strip similar tags like <integer>', () => {
    expect(stripInternalTags('<integer>5</integer>')).toBe(
      '<integer>5</integer>',
    );
  });

  it('leaves normal text unchanged', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
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
  //   if (!isMainGroup && group.requiresTrigger !== false) { check group.trigger }
  function shouldRequireTrigger(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
  ): boolean {
    return !isMainGroup && requiresTrigger !== false;
  }

  function shouldProcess(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
    trigger: string | undefined,
    messages: NewMessage[],
  ): boolean {
    if (!shouldRequireTrigger(isMainGroup, requiresTrigger)) return true;
    const triggerPattern = getTriggerPattern(trigger);
    return messages.some((m) => triggerPattern.test(m.content.trim()));
  }

  it('main group always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, undefined, undefined, msgs)).toBe(true);
  });

  it('main group processes even with requiresTrigger=true', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, true, undefined, msgs)).toBe(true);
  });

  it('non-main group with requiresTrigger=undefined requires trigger (defaults to true)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, undefined, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true requires trigger', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, true, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true processes when trigger present', () => {
    const msgs = [makeMsg({ content: '@TestBot do something' })];
    expect(shouldProcess(false, true, '@TestBot', msgs)).toBe(true);
  });

  it('non-main group uses its per-group trigger instead of the default trigger', () => {
    const msgs = [makeMsg({ content: '@Claw do something' })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(true);
  });

  it('non-main group does not process when only a different trigger is present', () => {
    const msgs = [makeMsg({ content: '@Other do something' })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=false always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, false, undefined, msgs)).toBe(true);
  });
});

describe('extractImages', () => {
  it('returns text unchanged when no image tags', () => {
    const result = extractImages('Hello world');
    expect(result.cleanText).toBe('Hello world');
    expect(result.images).toEqual([]);
  });

  it('extracts a single image tag with caption', () => {
    const result = extractImages(
      'Here is a photo <image path="https://example.com/pic.jpg" caption="A photo" />',
    );
    expect(result.cleanText).toBe('Here is a photo');
    expect(result.images).toEqual([
      { path: 'https://example.com/pic.jpg', caption: 'A photo' },
    ]);
  });

  it('extracts image tag without caption', () => {
    const result = extractImages('<image path="/tmp/photo.png" />');
    expect(result.cleanText).toBe('');
    expect(result.images).toEqual([
      { path: '/tmp/photo.png', caption: undefined },
    ]);
  });

  it('extracts multiple image tags', () => {
    const result = extractImages(
      'First <image path="a.jpg" caption="A" /> middle <image path="b.jpg" caption="B" /> end',
    );
    expect(result.cleanText).toBe('First  middle  end');
    expect(result.images).toHaveLength(2);
    expect(result.images[0]).toEqual({ path: 'a.jpg', caption: 'A' });
    expect(result.images[1]).toEqual({ path: 'b.jpg', caption: 'B' });
  });

  it('handles image-only output (no surrounding text)', () => {
    const result = extractImages('<image path="photo.jpg" caption="Done" />');
    expect(result.cleanText).toBe('');
    expect(result.images).toHaveLength(1);
  });
});
