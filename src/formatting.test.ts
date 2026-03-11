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
  it.each([
    ['a & b', 'a &amp; b'],
    ['a < b', 'a &lt; b'],
    ['a > b', 'a &gt; b'],
    ['"hello"', '&quot;hello&quot;'],
    ['a & b < c > d "e"', 'a &amp; b &lt; c &gt; d &quot;e&quot;'],
    ['hello world', 'hello world'],
    ['', ''],
  ])('escapeXml(%j) = %j', (input, expected) => {
    expect(escapeXml(input)).toBe(expected);
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  it('formats a single message as XML', () => {
    const result = formatMessages([makeMsg()]);
    expect(result).toBe(
      '<messages>\n' +
        '<message sender="Alice" sender_id="123@s.whatsapp.net" time="2024-01-01T00:00:00.000Z">hello</message>\n' +
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
  function shouldProcess(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
    messages: NewMessage[],
  ): boolean {
    if (isMainGroup || requiresTrigger === false) return true;
    return messages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
  }

  const noTrigger = [makeMsg({ content: 'hello no trigger' })];
  const withTrigger = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];

  it.each([
    {
      isMain: true,
      requiresTrigger: undefined,
      msgs: noTrigger,
      expected: true,
      label: 'main always processes',
    },
    {
      isMain: true,
      requiresTrigger: true,
      msgs: noTrigger,
      expected: true,
      label: 'main ignores requiresTrigger',
    },
    {
      isMain: false,
      requiresTrigger: undefined,
      msgs: noTrigger,
      expected: false,
      label: 'non-main defaults to requiring trigger',
    },
    {
      isMain: false,
      requiresTrigger: true,
      msgs: noTrigger,
      expected: false,
      label: 'non-main requires trigger when set',
    },
    {
      isMain: false,
      requiresTrigger: true,
      msgs: withTrigger,
      expected: true,
      label: 'non-main processes when trigger present',
    },
    {
      isMain: false,
      requiresTrigger: false,
      msgs: noTrigger,
      expected: true,
      label: 'non-main with requiresTrigger=false always processes',
    },
  ] as const)('$label', ({ isMain, requiresTrigger, msgs, expected }) => {
    expect(shouldProcess(isMain, requiresTrigger, msgs)).toBe(expected);
  });
});
