import { describe, expect, it } from 'vitest';

import { formatMessages } from './router.js';
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

const TZ = 'UTC';

describe('formatMessages — basic XML rendering', () => {
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

  it('handles empty array', () => {
    const result = formatMessages([], TZ);
    expect(result).toContain('timezone="UTC"');
    expect(result).toContain('<messages>\n\n</messages>');
  });
});

describe('formatMessages — XML escaping', () => {
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

  it('escapes special characters in model name', () => {
    const result = formatMessages([makeMsg()], TZ, undefined, 'model<>&"test');
    expect(result).toContain('model="model&lt;&gt;&amp;&quot;test"');
  });
});

describe('formatMessages — reply context', () => {
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
});

describe('formatMessages — timezone', () => {
  it('converts timestamps to local time for given timezone', () => {
    const result = formatMessages(
      [makeMsg({ timestamp: '2024-01-01T18:30:00.000Z' })],
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('timezone="America/New_York"');
  });
});

describe('formatMessages — pendingModelNotice', () => {
  const notice = '[model has switched from sonnet to opus]';

  function makeGroup(
    overrides: Partial<RegisteredGroup> = {},
  ): RegisteredGroup {
    return {
      name: 'test',
      folder: 'test',
      trigger: '@test',
      added_at: '2024-01-01',
      ...overrides,
    };
  }

  it('includes <notice> when group has pendingModelNotice', () => {
    const group = makeGroup({ pendingModelNotice: notice });
    const result = formatMessages([makeMsg()], TZ, group);
    expect(result).toContain(`<notice>${notice}</notice>`);
    expect(result).toContain('<message sender="Alice"');
  });

  it('clears pendingModelNotice after consumption', () => {
    const group = makeGroup({ pendingModelNotice: notice });
    formatMessages([makeMsg()], TZ, group);
    expect(group.pendingModelNotice).toBeUndefined();
  });

  it('does not include <notice> on second call', () => {
    const group = makeGroup({ pendingModelNotice: notice });
    formatMessages([makeMsg()], TZ, group);
    const result = formatMessages([makeMsg()], TZ, group);
    expect(result).not.toContain('<notice>');
  });

  it('does not include <notice> when no group is passed', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).not.toContain('<notice>');
  });

  it('does not include <notice> when group has no pending notice', () => {
    const group = makeGroup();
    const result = formatMessages([makeMsg()], TZ, group);
    expect(result).not.toContain('<notice>');
  });
});

describe('formatMessages — model attribute', () => {
  it('includes model attribute in context header when provided', () => {
    const result = formatMessages(
      [makeMsg()],
      TZ,
      undefined,
      'claude-opus-4-20250514',
    );
    expect(result).toContain('model="claude-opus-4-20250514"');
  });

  it('omits model attribute when not provided', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).not.toContain('model=');
  });
});
