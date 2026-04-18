import { describe, it, expect, vi } from 'vitest';
import {
  GmailOpsRouter,
  type GmailOpsProvider,
  type EmailMeta,
} from '../gmail-ops.js';
import type { DraftInfo } from '../draft-enrichment.js';

function makeMockProvider(meta: EmailMeta | null = null): GmailOpsProvider {
  return {
    archiveThread: vi.fn().mockResolvedValue(undefined),
    listRecentDrafts: vi.fn().mockResolvedValue([] as DraftInfo[]),
    updateDraft: vi.fn().mockResolvedValue(undefined),
    getMessageBody: vi.fn().mockResolvedValue(null),
    getMessageMeta: vi.fn().mockResolvedValue(meta),
  };
}

describe('GmailOpsRouter.getMessageMeta', () => {
  it('delegates getMessageMeta to the correct channel', async () => {
    const router = new GmailOpsRouter();
    const meta: EmailMeta = {
      subject: 'Hello',
      from: 'sender@example.com',
      to: 'me@example.com',
      date: 'Thu, 1 Jan 2026 00:00:00 +0000',
      body: 'Email body text',
    };
    const provider = makeMockProvider(meta);
    router.register('personal', provider);

    const result = await router.getMessageMeta('personal', 'msg123');
    expect(provider.getMessageMeta).toHaveBeenCalledWith('msg123');
    expect(result).toEqual(meta);
  });

  it('propagates null when provider returns null', async () => {
    const router = new GmailOpsRouter();
    const provider = makeMockProvider(null);
    router.register('personal', provider);

    const result = await router.getMessageMeta('personal', 'missing-msg');
    expect(result).toBeNull();
  });

  it('includes optional cc field when present', async () => {
    const router = new GmailOpsRouter();
    const meta: EmailMeta = {
      subject: 'CC Test',
      from: 'sender@example.com',
      to: 'me@example.com',
      date: 'Thu, 1 Jan 2026 00:00:00 +0000',
      cc: 'cc@example.com',
      body: 'Body text',
    };
    const provider = makeMockProvider(meta);
    router.register('personal', provider);

    const result = await router.getMessageMeta('personal', 'msg-cc');
    expect(result?.cc).toBe('cc@example.com');
  });

  it('throws for unknown account', async () => {
    const router = new GmailOpsRouter();
    await expect(router.getMessageMeta('unknown', 'msg123')).rejects.toThrow(
      'No Gmail channel registered for account: unknown',
    );
  });
});
