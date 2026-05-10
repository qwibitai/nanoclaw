/**
 * v1-parity tests for formatter behavior.
 *
 * Port of src/v1/formatting.test.ts (at commit 27c5220, parent of the v1
 * deletion commit 86becf8). Covers: context timezone header, reply_to +
 * quoted_message rendering, XML escaping, and stripInternalTags.
 *
 * Timestamp-format assertions use `formatLocalTime()` output format, which
 * is host locale-dependent for decorators (month abbr, "," separator) but
 * stable for the numeric parts we assert on (hour, minute, year).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { formatMessages, stripInternalTags } from './formatter.js';
import { TIMEZONE } from './timezone.js';

// seq is NULL-allowed in the schema; assign monotonically per test so
// `getPendingMessages` ORDER BY seq is deterministic.
let nextSeq = 1;

beforeEach(() => {
  initTestSessionDb();
  nextSeq = 1;
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { timestamp?: string; trigger?: number; seq?: number },
) {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  const trigger = opts?.trigger ?? 1;
  const seq = opts?.seq ?? nextSeq++;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, seq, content)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(id, kind, timestamp, trigger, seq, JSON.stringify(content));
}

describe('context timezone header', () => {
  it('prepends <context timezone="..."/> to formatted output', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hello' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('includes the header even when the message list is empty', () => {
    const result = formatMessages([]);
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('header comes before the <messages> block', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    const ctxIdx = result.indexOf('<context');
    const msgsIdx = result.indexOf('<messages>');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(msgsIdx).toBeGreaterThan(ctxIdx);
  });
});

describe('timestamp formatting', () => {
  it('renders time via formatLocalTime (user TZ)', () => {
    // 2026-06-15T12:00:00Z — timezone-agnostic assertions (year is stable)
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T12:00:00.000Z' });
    const result = formatMessages(getPendingMessages());
    // formatLocalTime's format in en-US contains the year and a month abbrev
    expect(result).toContain('2026');
    expect(result).toMatch(/Jun/);
  });

  it('uses 12-hour AM/PM format', () => {
    // 15:30 UTC — some hour will show with AM or PM depending on TZ
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T15:30:00.000Z' });
    const result = formatMessages(getPendingMessages());
    expect(result).toMatch(/(AM|PM)/);
  });
});

describe('reply_to + quoted_message rendering', () => {
  it('renders reply_to attribute and quoted_message when all fields present', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'Yes, on my way!',
      replyTo: { id: '42', sender: 'Bob', text: 'Are you coming tonight?' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).toContain('<quoted_message from="Bob">Are you coming tonight?</quoted_message>');
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('omits reply_to and quoted_message when no reply context', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'plain' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('renders reply_to but omits quoted_message when original content is missing', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'ack',
      replyTo: { id: '42', sender: 'Bob' }, // no text
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('XML-escapes reply context', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'reply',
      replyTo: { id: '1', sender: 'A & B', text: '<script>alert("xss")</script>' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
  });
});

describe('XML escaping', () => {
  it('escapes <, >, &, " in sender and body', () => {
    insertMessage('m1', 'chat', {
      sender: 'A & B <Co>',
      text: '<script>alert("xss")</script>',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
    expect(result).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

describe('trigger-flag split', () => {
  it('all-trigger-1 batch renders as the legacy single <message> (one row)', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { trigger: 1 });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<message');
    expect(result).not.toContain('<thread_context');
    expect(result).not.toContain('<addressed_to_you');
    expect(result).not.toContain('<messages>');
  });

  it('all-trigger-1 batch renders as the legacy <messages> group (multiple rows)', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' }, { trigger: 1 });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' }, { trigger: 1 });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<messages>');
    expect(result).toContain('</messages>');
    expect(result).not.toContain('<thread_context');
    expect(result).not.toContain('<addressed_to_you');
  });

  it('mixed batch wraps trigger=0 in <thread_context> and trigger=1 in <addressed_to_you>', () => {
    insertMessage('ctx', 'chat', { sender: 'James', text: '@dae' }, { trigger: 0 });
    insertMessage('ask', 'chat', { sender: 'Dave', text: 'where are we?' }, { trigger: 1 });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<thread_context');
    expect(result).toContain('</thread_context>');
    expect(result).toContain('<addressed_to_you');
    expect(result).toContain('</addressed_to_you>');
    // The context must come BEFORE the addressed block so the agent reads
    // background first and arrives at the addressed message with full context.
    const ctxIdx = result.indexOf('<thread_context');
    const addrIdx = result.indexOf('<addressed_to_you');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(addrIdx).toBeGreaterThan(ctxIdx);
    // Each block contains the right message.
    const ctxBlock = result.slice(ctxIdx, addrIdx);
    const addrBlock = result.slice(addrIdx);
    expect(ctxBlock).toContain('@dae');
    expect(ctxBlock).not.toContain('where are we?');
    expect(addrBlock).toContain('where are we?');
    expect(addrBlock).not.toContain('@dae');
  });

  it('multiple context messages preserve order inside <thread_context>', () => {
    insertMessage('c1', 'chat', { sender: 'A', text: 'first ctx' }, { trigger: 0 });
    insertMessage('c2', 'chat', { sender: 'B', text: 'second ctx' }, { trigger: 0 });
    insertMessage('m1', 'chat', { sender: 'C', text: 'addressed' }, { trigger: 1 });
    const result = formatMessages(getPendingMessages());
    const firstIdx = result.indexOf('first ctx');
    const secondIdx = result.indexOf('second ctx');
    // Match the message body, not the surrounding `<addressed_to_you ...>` tag.
    const addrIdx = result.indexOf('>addressed</');
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(addrIdx).toBeGreaterThan(secondIdx);
  });

  it('multiple addressed messages render unwrapped inside <addressed_to_you>', () => {
    insertMessage('c1', 'chat', { sender: 'A', text: 'ctx' }, { trigger: 0 });
    insertMessage('m1', 'chat', { sender: 'B', text: 'one' }, { trigger: 1 });
    insertMessage('m2', 'chat', { sender: 'C', text: 'two' }, { trigger: 1 });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<addressed_to_you');
    // Both addressed messages appear inside the addressed block (no inner
    // <messages> wrapper — the parent block already groups them).
    const addrStart = result.indexOf('<addressed_to_you');
    const addrEnd = result.indexOf('</addressed_to_you>');
    const addrBlock = result.slice(addrStart, addrEnd);
    expect(addrBlock).toContain('one');
    expect(addrBlock).toContain('two');
  });

  it('context-only batch (no trigger=1) still emits <thread_context> with no <addressed_to_you>', () => {
    // This shape can hit the formatter via the mid-turn pollHandle push when
    // a batch of accumulated rows arrives with no fresh trigger=1. The agent
    // reads them as background and continues whatever it was doing.
    insertMessage('c1', 'chat', { sender: 'A', text: 'just context' }, { trigger: 0 });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<thread_context');
    expect(result).toContain('just context');
    expect(result).not.toContain('<addressed_to_you');
  });

  it('preserves the timezone header before the trigger-split blocks', () => {
    insertMessage('c1', 'chat', { sender: 'A', text: 'ctx' }, { trigger: 0 });
    insertMessage('m1', 'chat', { sender: 'B', text: 'addressed' }, { trigger: 1 });
    const result = formatMessages(getPendingMessages());
    const ctxHeaderIdx = result.indexOf('<context timezone');
    const threadIdx = result.indexOf('<thread_context');
    expect(ctxHeaderIdx).toBeGreaterThanOrEqual(0);
    expect(threadIdx).toBeGreaterThan(ctxHeaderIdx);
  });
});

describe('formatSystemMessage', () => {
  it('test_formatSystemMessage_recall_context_subtype', () => {
    insertMessage('sys1', 'system', { subtype: 'recall_context', text: 'Apollo uses Snowflake' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[Recalled context]\nApollo uses Snowflake');
  });

  it('test_formatSystemMessage_action_result', () => {
    insertMessage('sys2', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const result = formatMessages(getPendingMessages());
    // Upstream PR #2329 switched from the legacy "[SYSTEM RESPONSE]" prose
    // form to a structured <system_response> XML element; recall_context
    // (above) keeps its plain "[Recalled context]" form because the agent
    // reads it as ambient memory, not a structured response to act on.
    expect(result).toContain('<system_response');
    expect(result).toContain('action="register_group"');
    expect(result).toContain('status="success"');
    expect(result).toContain('"id":"ag-1"');
  });
});

describe('dispatch envelope (_dispatch)', () => {
  it('test_dispatch_envelope_renders_text_only', () => {
    insertMessage('dm1', 'chat', { _dispatch: { task_id: 'dispatch-abc' }, text: 'Do X' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('Do X');
    // _dispatch JSON should NOT appear in user-visible text
    expect(result).not.toContain('"_dispatch"');
  });

  it('test_dispatch_envelope_exposes_task_id_to_system', () => {
    insertMessage('dm2', 'chat', { _dispatch: { task_id: 'dispatch-abc' }, text: 'Do X' });
    const result = formatMessages(getPendingMessages());
    // task_id must appear in the system context section
    expect(result).toContain('dispatch-abc');
  });

  it('test_plain_text_unchanged', () => {
    insertMessage('pm1', 'chat', { sender: 'Alice', text: 'Hello world' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('Hello world');
  });

  it('test_non_dispatch_json_renders_text_field', () => {
    insertMessage('nm1', 'chat', { text: 'Hi' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('Hi');
    expect(result).not.toContain('"_dispatch"');
  });

  it('test_dispatch_envelope_does_not_leak_json_as_visible_text', () => {
    insertMessage('dm3', 'chat', { _dispatch: { task_id: 'dispatch-xyz' }, text: 'Run the analysis' });
    const result = formatMessages(getPendingMessages());
    // The raw JSON envelope must not appear in user-visible output
    expect(result).not.toContain('_dispatch_cancel');
    expect(result).not.toContain('"task_id":"dispatch-xyz"');
    // But the task_id itself should appear in a structured system note
    expect(result).toContain('dispatch-xyz');
  });
});

describe('dispatch cancel envelope (_dispatch_cancel)', () => {
  it('test_dispatch_cancel_envelope_renders_as_system_note', () => {
    insertMessage('dc1', 'system', {
      _dispatch_cancel: { task_id: 'dispatch-abc', reason: 'orchestrator override' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('cancelled by the orchestrator');
    expect(result).toContain('orchestrator override');
    // Raw JSON envelope must NOT appear as user-visible text
    expect(result).not.toContain('"_dispatch_cancel"');
  });

  it('test_dispatch_cancel_envelope_without_reason_uses_placeholder', () => {
    insertMessage('dc2', 'system', {
      _dispatch_cancel: { task_id: 'dispatch-abc' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('cancelled by the orchestrator');
    expect(result).toContain('(none)');
    // Must not throw — this is a critical invariant
    expect(result).not.toContain('"_dispatch_cancel"');
  });

  it('test_dispatch_cancel_envelope_task_id_does_not_appear_as_visible_json', () => {
    insertMessage('dc3', 'system', {
      _dispatch_cancel: { task_id: 'dispatch-test', reason: 'test reason' },
    });
    const result = formatMessages(getPendingMessages());
    // Should be a plain readable system note, not raw JSON
    expect(result).not.toContain('"task_id"');
  });
});

describe('stripInternalTags', () => {
  it('strips single-line internal tags and trims', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe('hello  world');
  });

  it('strips multi-line internal tags', () => {
    expect(stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multiple internal tag blocks', () => {
    expect(stripInternalTags('<internal>a</internal>hello<internal>b</internal>')).toBe('hello');
  });

  it('returns empty string when input is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });

  it('returns input unchanged when there are no internal tags', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });

  it('preserves content that surrounds internal tags', () => {
    expect(stripInternalTags('<internal>thinking</internal>The answer is 42')).toBe(
      'The answer is 42',
    );
  });
});
