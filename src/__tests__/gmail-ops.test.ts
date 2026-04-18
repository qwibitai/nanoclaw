import { describe, it, expect, vi } from 'vitest';
import { GmailOpsRouter } from '../gmail-ops.js';
import type { DraftInfo } from '../draft-enrichment.js';

describe('GmailOpsRouter', () => {
  function makeMockChannel(alias: string) {
    return {
      name: `gmail-${alias}`,
      archiveThread: vi.fn().mockResolvedValue(undefined),
      listRecentDrafts: vi.fn().mockResolvedValue([] as DraftInfo[]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue('Hello world'),
    };
  }

  it('routes archiveThread to the correct channel', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('personal');
    router.register('personal', channel as any);
    await router.archiveThread('personal', 'thread123');
    expect(channel.archiveThread).toHaveBeenCalledWith('thread123');
  });

  it('routes listRecentDrafts to the correct channel', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('dev');
    router.register('dev', channel as any);
    await router.listRecentDrafts('dev');
    expect(channel.listRecentDrafts).toHaveBeenCalled();
  });

  it('routes getMessageBody to the correct channel', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('personal');
    router.register('personal', channel as any);
    const body = await router.getMessageBody('personal', 'msg456');
    expect(body).toBe('Hello world');
    expect(channel.getMessageBody).toHaveBeenCalledWith('msg456');
  });

  it('throws for unknown account', async () => {
    const router = new GmailOpsRouter();
    await expect(router.archiveThread('unknown', 'thread1')).rejects.toThrow(
      'No Gmail channel registered for account: unknown',
    );
  });

  it('routes updateDraft to the correct channel', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('attaxion');
    router.register('attaxion', channel as any);
    await router.updateDraft('attaxion', 'draft789', 'new body');
    expect(channel.updateDraft).toHaveBeenCalledWith('draft789', 'new body');
  });
});
