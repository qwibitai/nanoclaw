import { describe, it, expect } from 'vitest';

import {
  ASSISTANT_NAME,
  getTriggerPattern,
  TRIGGER_PATTERN,
} from './config.js';
import {
  escapeXml,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import { parseTextStyles, parseSignalStyles } from './text-styles.js';
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
  const TZ = 'UTC';

  it('formats a single message as XML with context header', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).toContain('<context timezone="UTC" />');
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
    expect(result).toContain('<context timezone="UTC" />');
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
    expect(result).toContain('<context timezone="America/New_York" />');
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

describe('getTriggerPattern', () => {
  it('uses the configured per-group trigger when provided', () => {
    const pattern = getTriggerPattern('@Claw');

    expect(pattern.test('@Claw hello')).toBe(true);
    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(false);
  });

  it('falls back to the default trigger when group trigger is missing', () => {
    const pattern = getTriggerPattern(undefined);

    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(true);
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
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(false, true, undefined, msgs)).toBe(true);
  });

  it('non-main group uses its per-group trigger instead of the default trigger', () => {
    const msgs = [makeMsg({ content: '@Claw do something' })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(true);
  });

  it('non-main group does not process when only the default trigger is present for a custom-trigger group', () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=false always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, false, undefined, msgs)).toBe(true);
  });
});

// --- parseTextStyles ---

describe('parseTextStyles — passthrough channels', () => {
  it('passes text through unchanged on discord', () => {
    const md = '**bold** and *italic* and [link](https://example.com)';
    expect(parseTextStyles(md, 'discord')).toBe(md);
  });

  it('passes text through unchanged on signal (signal uses parseSignalStyles)', () => {
    const md = '**bold** and *italic* and [link](https://example.com)';
    expect(parseTextStyles(md, 'signal')).toBe(md);
  });
});

describe('parseTextStyles — bold', () => {
  it('converts **bold** to *bold* on whatsapp', () => {
    expect(parseTextStyles('**hello**', 'whatsapp')).toBe('*hello*');
  });

  it('converts **bold** to *bold* on telegram', () => {
    expect(parseTextStyles('say **this** now', 'telegram')).toBe(
      'say *this* now',
    );
  });

  it('converts **bold** to *bold* on slack', () => {
    expect(parseTextStyles('**hello**', 'slack')).toBe('*hello*');
  });

  it('does not convert a lone * as bold', () => {
    expect(parseTextStyles('a * b * c', 'whatsapp')).toBe('a * b * c');
  });
});

describe('parseTextStyles — italic', () => {
  it('converts *italic* to _italic_ on whatsapp', () => {
    expect(parseTextStyles('say *this* now', 'whatsapp')).toBe(
      'say _this_ now',
    );
  });

  it('converts *italic* to _italic_ on telegram', () => {
    expect(parseTextStyles('*italic*', 'telegram')).toBe('_italic_');
  });

  it('bold-before-italic: **bold** *italic* → *bold* _italic_', () => {
    expect(parseTextStyles('**bold** *italic*', 'whatsapp')).toBe(
      '*bold* _italic_',
    );
  });
});

describe('parseTextStyles — headings', () => {
  it('converts # heading on whatsapp', () => {
    expect(parseTextStyles('# Top', 'whatsapp')).toBe('*Top*');
  });

  it('converts ## heading on telegram', () => {
    expect(parseTextStyles('## Hello World', 'telegram')).toBe('*Hello World*');
  });

  it('converts ### heading on telegram', () => {
    expect(parseTextStyles('### Section', 'telegram')).toBe('*Section*');
  });

  it('only converts headings at line start', () => {
    const input = 'not a ## heading in middle';
    expect(parseTextStyles(input, 'whatsapp')).toBe(input);
  });
});

describe('parseTextStyles — links', () => {
  it('converts [text](url) to text (url) on whatsapp', () => {
    expect(parseTextStyles('[Link](https://example.com)', 'whatsapp')).toBe(
      'Link (https://example.com)',
    );
  });

  it('converts [text](url) to text (url) on telegram', () => {
    expect(parseTextStyles('[Link](https://example.com)', 'telegram')).toBe(
      'Link (https://example.com)',
    );
  });

  it('converts [text](url) to <url|text> on slack', () => {
    expect(parseTextStyles('[Click here](https://example.com)', 'slack')).toBe(
      '<https://example.com|Click here>',
    );
  });
});

describe('parseTextStyles — horizontal rules', () => {
  it('strips --- on telegram', () => {
    expect(parseTextStyles('above\n---\nbelow', 'telegram')).toBe(
      'above\n\nbelow',
    );
  });

  it('strips *** on whatsapp', () => {
    expect(parseTextStyles('above\n***\nbelow', 'whatsapp')).toBe(
      'above\n\nbelow',
    );
  });
});

describe('parseTextStyles — code block protection', () => {
  it('does not transform **bold** inside fenced code block', () => {
    const input = '```\n**not bold**\n```';
    expect(parseTextStyles(input, 'whatsapp')).toBe(input);
  });

  it('does not transform *italic* inside inline code', () => {
    const input = 'use `*star*` literally';
    expect(parseTextStyles(input, 'telegram')).toBe(input);
  });

  it('transforms text outside code blocks but not inside', () => {
    const input = '**bold** and `*code*` and *italic*';
    expect(parseTextStyles(input, 'whatsapp')).toBe(
      '*bold* and `*code*` and _italic_',
    );
  });

  it('transforms text outside fenced block but not inside', () => {
    const input = '**bold**\n```\n**raw**\n```\n*italic*';
    expect(parseTextStyles(input, 'telegram')).toBe(
      '*bold*\n```\n**raw**\n```\n_italic_',
    );
  });
});

// --- parseSignalStyles ---

describe('parseSignalStyles — basic styles', () => {
  it('extracts BOLD from **text**', () => {
    const { text, textStyle } = parseSignalStyles('**hello**');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'BOLD', start: 0, length: 5 }]);
  });

  it('extracts ITALIC from *text*', () => {
    const { text, textStyle } = parseSignalStyles('*hello*');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'ITALIC', start: 0, length: 5 }]);
  });

  it('extracts ITALIC from _text_', () => {
    const { text, textStyle } = parseSignalStyles('_hello_');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'ITALIC', start: 0, length: 5 }]);
  });

  it('extracts STRIKETHROUGH from ~~text~~', () => {
    const { text, textStyle } = parseSignalStyles('~~hello~~');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([
      { style: 'STRIKETHROUGH', start: 0, length: 5 },
    ]);
  });

  it('extracts MONOSPACE from `inline code`', () => {
    const { text, textStyle } = parseSignalStyles('`code`');
    expect(text).toBe('code');
    expect(textStyle).toEqual([{ style: 'MONOSPACE', start: 0, length: 4 }]);
  });

  it('extracts BOLD from ## heading and strips marker', () => {
    const { text, textStyle } = parseSignalStyles('## Hello World');
    expect(text).toBe('Hello World');
    expect(textStyle).toEqual([{ style: 'BOLD', start: 0, length: 11 }]);
  });

  it('no styles for plain text', () => {
    const { text, textStyle } = parseSignalStyles('just plain text');
    expect(text).toBe('just plain text');
    expect(textStyle).toHaveLength(0);
  });
});

describe('parseSignalStyles — mixed content', () => {
  it('correctly offsets styles in mixed text', () => {
    const { text, textStyle } = parseSignalStyles('say **hi** now');
    expect(text).toBe('say hi now');
    expect(textStyle).toEqual([{ style: 'BOLD', start: 4, length: 2 }]);
  });

  it('handles multiple styles with correct offsets', () => {
    const { text, textStyle } = parseSignalStyles('**bold** and *italic*');
    expect(text).toBe('bold and italic');
    expect(textStyle[0]).toEqual({ style: 'BOLD', start: 0, length: 4 });
    expect(textStyle[1]).toEqual({ style: 'ITALIC', start: 9, length: 6 });
  });

  it('strips link markers, no style applied', () => {
    const { text, textStyle } = parseSignalStyles(
      '[Click here](https://example.com)',
    );
    expect(text).toBe('Click here (https://example.com)');
    expect(textStyle).toHaveLength(0);
  });

  it('strips horizontal rules', () => {
    const { text, textStyle } = parseSignalStyles('above\n---\nbelow');
    expect(text).toBe('above\nbelow');
    expect(textStyle).toHaveLength(0);
  });
});

describe('parseSignalStyles — code block protection', () => {
  it('protects fenced code block content with MONOSPACE', () => {
    const input = '```\n**not bold**\n```';
    const { text, textStyle } = parseSignalStyles(input);
    expect(text).toBe('**not bold**');
    expect(textStyle).toEqual([{ style: 'MONOSPACE', start: 0, length: 12 }]);
  });

  it('styles outside block are still processed', () => {
    const input = '**bold**\n```\nraw code\n```';
    const { text, textStyle } = parseSignalStyles(input);
    expect(text).toContain('bold');
    expect(text).toContain('raw code');
    const boldStyle = textStyle.find((s) => s.style === 'BOLD');
    const codeStyle = textStyle.find((s) => s.style === 'MONOSPACE');
    expect(boldStyle).toBeDefined();
    expect(codeStyle).toBeDefined();
  });
});

describe('parseSignalStyles — snake_case guard', () => {
  it('does not italicise underscores in snake_case', () => {
    const { text, textStyle } = parseSignalStyles('use snake_case_here');
    expect(text).toBe('use snake_case_here');
    expect(textStyle).toHaveLength(0);
  });
});

describe('formatOutbound — channel-aware', () => {
  it('applies parseTextStyles when channel is provided', () => {
    expect(formatOutbound('**bold**', 'whatsapp')).toBe('*bold*');
  });

  it('returns plain stripped text when no channel provided', () => {
    expect(formatOutbound('**bold**')).toBe('**bold**');
  });

  it('strips internal tags then applies channel formatting', () => {
    expect(
      formatOutbound('<internal>thinking</internal>**done**', 'telegram'),
    ).toBe('*done*');
  });

  it('signal channel is passthrough — raw markdown preserved for parseSignalStyles', () => {
    expect(formatOutbound('**bold**', 'signal')).toBe('**bold**');
  });
});
