import { describe, it, expect, vi } from 'vitest';
import { GmailOpsRouter, deriveLocalPart } from '../gmail-ops.js';
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

  it('resolves full email address to alias via reverse map', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('personal');
    (channel as any).emailAddress = 'topcoder1@gmail.com';
    router.register('personal', channel as any);
    await router.archiveThread('topcoder1@gmail.com', 'thread123');
    expect(channel.archiveThread).toHaveBeenCalledWith('thread123');
  });

  it('prefers alias over email when both could match', async () => {
    const router = new GmailOpsRouter();
    const ch1 = makeMockChannel('personal');
    (ch1 as any).emailAddress = 'topcoder1@gmail.com';
    const ch2 = makeMockChannel('dev');
    (ch2 as any).emailAddress = 'dev@whoisxmlapi.com';
    router.register('personal', ch1 as any);
    router.register('dev', ch2 as any);
    await router.archiveThread('personal', 'thread123');
    expect(ch1.archiveThread).toHaveBeenCalledWith('thread123');
  });

  it('still throws for completely unknown account', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('personal');
    (channel as any).emailAddress = 'topcoder1@gmail.com';
    router.register('personal', channel as any);
    await expect(
      router.archiveThread('nobody@example.com', 'thread1'),
    ).rejects.toThrow(
      'No Gmail channel registered for account: nobody@example.com',
    );
  });

  it('resolves bare email local-part to alias (SSE sends "topcoder1", not "personal")', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('personal');
    (channel as any).emailAddress = 'topcoder1@gmail.com';
    router.register('personal', channel as any);
    const body = await router.getMessageBody('topcoder1', 'msg1');
    expect(body).toBe('Hello world');
    expect(channel.getMessageBody).toHaveBeenCalledWith('msg1');
  });

  it('derives local-part from email or bare string', () => {
    expect(deriveLocalPart('topcoder1@gmail.com')).toBe('topcoder1');
    expect(deriveLocalPart('Topcoder1')).toBe('topcoder1');
    expect(deriveLocalPart('dev@whoisxmlapi.com')).toBe('dev');
    expect(deriveLocalPart('')).toBeNull();
  });

  it('local-part registration does not shadow an existing exact alias', async () => {
    const router = new GmailOpsRouter();
    const personal = makeMockChannel('personal');
    (personal as any).emailAddress = 'dev@gmail.com';
    const dev = makeMockChannel('dev');
    (dev as any).emailAddress = 'dev@whoisxmlapi.com';
    router.register('personal', personal as any);
    router.register('dev', dev as any);
    // "dev" is an explicit alias — must win over local-part("dev@gmail.com")
    await router.getMessageBody('dev', 'm');
    expect(dev.getMessageBody).toHaveBeenCalledWith('m');
    expect(personal.getMessageBody).not.toHaveBeenCalled();
  });

  it('handles channel without emailAddress gracefully', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('personal');
    // No emailAddress property
    router.register('personal', channel as any);
    // Direct alias still works
    await router.archiveThread('personal', 'thread123');
    expect(channel.archiveThread).toHaveBeenCalledWith('thread123');
    // But email lookup fails
    await expect(
      router.archiveThread('topcoder1@gmail.com', 'thread1'),
    ).rejects.toThrow();
  });
});
