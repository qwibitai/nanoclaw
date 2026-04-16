import { describe, it, expect, vi } from 'vitest';

describe('GmailChannel Gmail Ops methods', () => {
  function makeMockGmail() {
    return {
      users: {
        threads: {
          modify: vi.fn().mockResolvedValue({}),
        },
        drafts: {
          list: vi.fn().mockResolvedValue({
            data: {
              drafts: [{ id: 'draft1', message: { threadId: 'thread1' } }],
            },
          }),
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'draft1',
              message: {
                threadId: 'thread1',
                internalDate: String(Date.now()),
                payload: {
                  headers: [
                    { name: 'Subject', value: 'Test Subject' },
                    { name: 'To', value: 'user@example.com' },
                    { name: 'From', value: 'me@example.com' },
                  ],
                  mimeType: 'text/plain',
                  body: { data: Buffer.from('Draft body text').toString('base64') },
                },
              },
            },
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              payload: {
                mimeType: 'text/plain',
                body: { data: Buffer.from('Full message body').toString('base64') },
              },
            },
          }),
          modify: vi.fn().mockResolvedValue({}),
        },
      },
    };
  }

  it('archiveThread calls threads.modify with removeLabelIds INBOX', async () => {
    const { GmailChannel } = await import('../channels/gmail.js');
    const channel = new GmailChannel(
      { onMessage: vi.fn(), onChatMetadata: vi.fn(), registeredGroups: () => ({}) },
      'personal',
    );
    const mockGmail = makeMockGmail();
    (channel as any).gmail = mockGmail;

    await channel.archiveThread('thread123');
    expect(mockGmail.users.threads.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'thread123',
      requestBody: { removeLabelIds: ['INBOX'] },
    });
  });

  it('listRecentDrafts returns DraftInfo array', async () => {
    const { GmailChannel } = await import('../channels/gmail.js');
    const channel = new GmailChannel(
      { onMessage: vi.fn(), onChatMetadata: vi.fn(), registeredGroups: () => ({}) },
      'dev',
    );
    const mockGmail = makeMockGmail();
    (channel as any).gmail = mockGmail;
    (channel as any).accountAlias = 'dev';

    const drafts = await channel.listRecentDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      draftId: 'draft1',
      threadId: 'thread1',
      account: 'dev',
      subject: 'Test Subject',
      body: 'Draft body text',
    });
  });

  it('getMessageBody returns extracted text body', async () => {
    const { GmailChannel } = await import('../channels/gmail.js');
    const channel = new GmailChannel(
      { onMessage: vi.fn(), onChatMetadata: vi.fn(), registeredGroups: () => ({}) },
      'personal',
    );
    const mockGmail = makeMockGmail();
    (channel as any).gmail = mockGmail;

    const body = await channel.getMessageBody('msg123');
    expect(body).toBe('Full message body');
    expect(mockGmail.users.messages.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'msg123',
      format: 'full',
    });
  });

  it('updateDraft calls drafts.update with re-encoded body', async () => {
    const { GmailChannel } = await import('../channels/gmail.js');
    const channel = new GmailChannel(
      { onMessage: vi.fn(), onChatMetadata: vi.fn(), registeredGroups: () => ({}) },
      'personal',
    );
    const mockGmail = makeMockGmail();
    (channel as any).gmail = mockGmail;

    await channel.updateDraft('draft1', 'New enriched body');
    expect(mockGmail.users.drafts.update).toHaveBeenCalled();
    const callArgs = mockGmail.users.drafts.update.mock.calls[0][0];
    expect(callArgs.userId).toBe('me');
    expect(callArgs.id).toBe('draft1');
    expect(callArgs.requestBody.message.raw).toBeTruthy();
  });
});
