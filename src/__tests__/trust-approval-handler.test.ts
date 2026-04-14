import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  _initTestDatabase,
  _closeDatabase,
  insertTrustApproval,
} from '../db.js';
import {
  formatApprovalPrompt,
  parseApprovalReply,
  handlePotentialApprovalReply,
} from '../trust-approval-handler.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('formatApprovalPrompt', () => {
  it('includes tool name and class', () => {
    const msg = formatApprovalPrompt(
      'abc123',
      'comms.write',
      'send_message',
      'Send status update',
      30,
    );
    expect(msg).toContain('send_message');
    expect(msg).toContain('comms');
    expect(msg).toContain('write');
    expect(msg).toContain('abc123');
    expect(msg).toContain('30 min');
  });

  it('omits details when description is undefined', () => {
    const msg = formatApprovalPrompt(
      'abc123',
      'code.write',
      'write_file',
      undefined,
      30,
    );
    expect(msg).not.toContain('Details');
  });

  it('uses correct emoji for operation types', () => {
    expect(formatApprovalPrompt('id', 'info.read', 't', undefined, 30)).toContain('\u{1F50D}');
    expect(formatApprovalPrompt('id', 'code.write', 't', undefined, 30)).toContain('\u{270F}');
    expect(formatApprovalPrompt('id', 'finance.transact', 't', undefined, 30)).toContain('\u{26A1}');
  });
});

describe('parseApprovalReply', () => {
  const pending = [
    {
      approvalId: 'abc123',
      toolName: 'send_message',
      actionClass: 'comms.write',
    },
  ];

  it('returns null when no pending approvals', () => {
    expect(parseApprovalReply('yes', [])).toBeNull();
  });

  it('approves on "yes"', () => {
    const result = parseApprovalReply('yes', pending);
    expect(result?.decision).toBe('approved');
  });

  it('approves on "approve"', () => {
    expect(parseApprovalReply('approve', pending)?.decision).toBe('approved');
  });

  it('denies on "no"', () => {
    expect(parseApprovalReply('no', pending)?.decision).toBe('denied');
  });

  it('denies on "deny"', () => {
    expect(parseApprovalReply('deny this', pending)?.decision).toBe('denied');
  });

  it('does not match ambiguous text', () => {
    expect(parseApprovalReply('what is this about?', pending)).toBeNull();
  });

  it('matches with explicit approval id even in multi-pending', () => {
    const multi = [
      {
        approvalId: 'abc123',
        toolName: 'send_message',
        actionClass: 'comms.write',
      },
      {
        approvalId: 'xyz456',
        toolName: 'write_file',
        actionClass: 'code.write',
      },
    ];
    const result = parseApprovalReply('yes abc123', multi);
    expect(result?.approvalId).toBe('abc123');
    expect(result?.decision).toBe('approved');
  });

  it('returns null for multi-pending without explicit id', () => {
    const multi = [
      {
        approvalId: 'abc123',
        toolName: 'send_message',
        actionClass: 'comms.write',
      },
      {
        approvalId: 'xyz456',
        toolName: 'write_file',
        actionClass: 'code.write',
      },
    ];
    expect(parseApprovalReply('yes', multi)).toBeNull();
  });
});

describe('handlePotentialApprovalReply', () => {
  function insertPendingApproval(
    id: string,
    chatJid: string,
    toolName: string = 'send_message',
  ) {
    const now = new Date();
    const expires = new Date(now.getTime() + 1800000);
    insertTrustApproval({
      id,
      action_class: 'comms.write',
      tool_name: toolName,
      group_id: 'group1',
      chat_jid: chatJid,
      status: 'pending',
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    });
  }

  it('returns false when no pending approvals exist', () => {
    expect(handlePotentialApprovalReply('yes', 'tg:123', [])).toBe(false);
  });

  it('resolves approval on "yes" reply', () => {
    insertPendingApproval('ap-1', 'tg:123');
    expect(handlePotentialApprovalReply('yes', 'tg:123', ['ap-1'])).toBe(true);
  });

  it('does not match approval from different chat', () => {
    insertPendingApproval('ap-1', 'tg:999');
    expect(handlePotentialApprovalReply('yes', 'tg:123', ['ap-1'])).toBe(
      false,
    );
  });

  it('ignores non-approval text', () => {
    insertPendingApproval('ap-1', 'tg:123');
    expect(
      handlePotentialApprovalReply('what is this?', 'tg:123', ['ap-1']),
    ).toBe(false);
  });
});
