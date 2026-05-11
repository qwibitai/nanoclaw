import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: vi.fn(),
}));

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn(),
}));

vi.mock('../db/dashboard-tokens.js', () => ({
  issueDashboardToken: vi.fn(),
}));

vi.mock('./cookie.js', () => ({
  resolveServerKey: vi.fn(() => Buffer.from('a'.repeat(64), 'hex')),
}));

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Suppress side-effect registration during test module load
vi.mock('../../command-gate.js', () => ({
  registerInterceptHandler: vi.fn(),
  getInterceptHandler: vi.fn(),
  clearInterceptHandlers: vi.fn(),
}));

import { dashboardTokenIssue } from './dashboard-token-issue.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { issueDashboardToken } from '../db/dashboard-tokens.js';
import type { MessagingGroup } from '../../types.js';
import crypto from 'crypto';

function makeCtx(overrides = {}) {
  return {
    userId: 'u1',
    replyMessagingGroupId: 'mg-1',
    command: '/dashboard-token',
    args: '',
    ...overrides,
  };
}

function makeSlackMg(): MessagingGroup {
  return {
    id: 'mg-1',
    channel_type: 'slack-test',
    platform_id: 'platform-1',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dashboardTokenIssue', () => {
  it('test_dashboardTokenIssue_inserts_hmac_row', async () => {
    const deliverMock = vi.fn().mockResolvedValue('msg-id');
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver: deliverMock } as never);
    vi.mocked(getMessagingGroup).mockReturnValue(makeSlackMg());
    vi.mocked(issueDashboardToken).mockReturnValue({
      id: 1,
      user_id: 'u1',
      token_hmac: 'hmac',
      issued_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
      used_at: null,
    });

    await dashboardTokenIssue(makeCtx());

    expect(issueDashboardToken).toHaveBeenCalledOnce();
    const [calledUserId, calledHmac, calledTtl] = vi.mocked(issueDashboardToken).mock.calls[0] as [
      string,
      string,
      number,
    ];
    expect(calledUserId).toBe('u1');
    expect(calledTtl).toBe(12); // 12h matches Set-Cookie Max-Age=43200 (post-build QA fix MF-2)

    // Verify HMAC matches what we'd compute from the raw token in the deliver call
    expect(deliverMock).toHaveBeenCalledOnce();
    const deliveredContent = JSON.parse(deliverMock.mock.calls[0][4] as string) as { text: string };
    const rawTokenMatch = deliveredContent.text.match(/([0-9a-f]{64})/);
    expect(rawTokenMatch).not.toBeNull();
    const rawToken = rawTokenMatch![1];

    // raw token must NOT equal the hmac stored
    expect(rawToken).not.toBe(calledHmac);

    // verify the hmac was computed correctly from the raw token
    const { resolveServerKey } = await import('./cookie.js');
    const serverKey = resolveServerKey();
    const expectedHmac = crypto.createHmac('sha256', serverKey).update(rawToken).digest('hex');
    expect(calledHmac).toBe(expectedHmac);
  });

  it('test_dashboardTokenIssue_reply_text_contains_url', async () => {
    const deliverMock = vi.fn().mockResolvedValue('msg-id');
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver: deliverMock } as never);
    vi.mocked(getMessagingGroup).mockReturnValue(makeSlackMg());
    vi.mocked(issueDashboardToken).mockReturnValue({
      id: 1,
      user_id: 'u1',
      token_hmac: 'hmac',
      issued_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
      used_at: null,
    });

    await dashboardTokenIssue(makeCtx());

    const deliveredContent = JSON.parse(deliverMock.mock.calls[0][4] as string) as { text: string };
    // URL must be present without ?token= query param
    expect(deliveredContent.text).toMatch(/https?:\/\/[^/]+\/dashboard\//);
    expect(deliveredContent.text).not.toMatch(/\?token=/);
    // Raw token (64 hex chars) must be present
    expect(deliveredContent.text).toMatch(/[0-9a-f]{64}/);
  });

  it('test_dashboardTokenIssue_token_entropy', async () => {
    const deliverMock = vi.fn().mockResolvedValue('msg-id');
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver: deliverMock } as never);
    vi.mocked(getMessagingGroup).mockReturnValue(makeSlackMg());
    vi.mocked(issueDashboardToken).mockReturnValue({
      id: 1,
      user_id: 'u1',
      token_hmac: 'hmac',
      issued_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
      used_at: null,
    });

    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      await dashboardTokenIssue(makeCtx());
      const deliveredContent = JSON.parse(deliverMock.mock.calls[i][4] as string) as { text: string };
      const match = deliveredContent.text.match(/([0-9a-f]{64})/);
      expect(match).not.toBeNull();
      const rawToken = match![1];
      expect(rawToken).toHaveLength(64);
      tokens.add(rawToken);
    }
    expect(tokens.size).toBe(100);
  });

  it('test_dashboardTokenIssue_no_messaging_group', async () => {
    const deliverMock = vi.fn();
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver: deliverMock } as never);
    vi.mocked(getMessagingGroup).mockReturnValue(undefined);

    await dashboardTokenIssue(makeCtx());

    // Must NOT call issueDashboardToken (no orphan token rows)
    expect(issueDashboardToken).not.toHaveBeenCalled();
    expect(deliverMock).not.toHaveBeenCalled();
  });
});
