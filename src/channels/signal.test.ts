import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SignalChannel, SignalChannelOpts } from './signal.js';

function makeOpts(overrides?: Partial<SignalChannelOpts>): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({
      'signal:group:abc': {
        name: 'Test',
        folder: 'test',
        trigger: '@Andy',
        added_at: '',
      },
    }),
    accountNumber: '+15550001111',
    ...overrides,
  };
}

// Drive handleNotification via private cast
function notify(channel: SignalChannel, method: string, params: object) {
  (channel as any).handleNotification({ jsonrpc: '2.0', method, params });
}

describe('SignalChannel attachment parsing', () => {
  let opts: SignalChannelOpts;
  let channel: SignalChannel;

  beforeEach(() => {
    opts = makeOpts();
    channel = new SignalChannel(opts);
  });

  it('parses image attachment and builds description in content', () => {
    notify(channel, 'receive', {
      envelope: {
        sourceNumber: '+15550002222',
        sourceName: 'Alice',
        timestamp: 1700000000000,
        dataMessage: {
          timestamp: 1700000000000,
          message: 'Check this out',
          groupInfo: { groupId: 'abc' },
          attachments: [
            {
              id: 9876543210,
              contentType: 'image/jpeg',
              filename: 'photo.jpg',
              size: 365568,
              width: 1440,
              height: 2560,
            },
          ],
        },
      },
    });

    expect(opts.onMessage).toHaveBeenCalledOnce();
    const msg = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(msg.content).toContain('Check this out');
    expect(msg.content).toContain(
      '[attachment: photo.jpg (image/jpeg, 357KB 1440x2560)]',
    );
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toMatchObject({
      id: '9876543210',
      contentType: 'image/jpeg',
      filename: 'photo.jpg',
      size: 365568,
      width: 1440,
      height: 2560,
    });
  });

  it('passes attachment-only message (no caption text)', () => {
    notify(channel, 'receive', {
      envelope: {
        sourceNumber: '+15550002222',
        sourceName: 'Alice',
        timestamp: 1700000000001,
        dataMessage: {
          timestamp: 1700000000001,
          // no message field
          groupInfo: { groupId: 'abc' },
          attachments: [
            {
              id: 1111,
              contentType: 'image/png',
              size: 102400,
            },
          ],
        },
      },
    });

    expect(opts.onMessage).toHaveBeenCalledOnce();
    const msg = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(msg.content).toContain('[attachment: unnamed (image/png,');
    expect(msg.attachments).toHaveLength(1);
  });

  it('drops messages with no text and no attachments', () => {
    notify(channel, 'receive', {
      envelope: {
        sourceNumber: '+15550002222',
        timestamp: 1700000000002,
        dataMessage: {
          timestamp: 1700000000002,
          groupInfo: { groupId: 'abc' },
        },
      },
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('marks voice note with (voice note) suffix', () => {
    notify(channel, 'receive', {
      envelope: {
        sourceNumber: '+15550002222',
        timestamp: 1700000000003,
        dataMessage: {
          timestamp: 1700000000003,
          groupInfo: { groupId: 'abc' },
          attachments: [
            {
              id: 2222,
              contentType: 'audio/ogg',
              size: 8192,
              voiceNote: true,
            },
          ],
        },
      },
    });

    expect(opts.onMessage).toHaveBeenCalledOnce();
    const msg = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(msg.content).toContain('(voice note)');
    expect(msg.attachments[0].isVoiceNote).toBe(true);
  });

  it('omits dimensions when width/height absent', () => {
    notify(channel, 'receive', {
      envelope: {
        sourceNumber: '+15550002222',
        timestamp: 1700000000004,
        dataMessage: {
          timestamp: 1700000000004,
          groupInfo: { groupId: 'abc' },
          attachments: [
            {
              id: 3333,
              contentType: 'application/pdf',
              filename: 'doc.pdf',
              size: 204800,
            },
          ],
        },
      },
    });

    const msg = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(msg.content).toBe('[attachment: doc.pdf (application/pdf, 200KB)]');
  });
});

describe('SignalChannel downloadAttachment', () => {
  it('skips RPC and returns existing path if file already on disk', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'signal-att-test-'));
    const channel = new SignalChannel(makeOpts());
    const rpcSpy = vi.spyOn(channel as any, 'rpcCall');

    // Pre-create the file that downloadAttachment would write
    const expectedPath = path.join(tmpDir, '9999-photo.jpg');
    writeFileSync(expectedPath, 'existing');

    const result = await channel.downloadAttachment(
      { id: '9999', contentType: 'image/jpeg', filename: 'photo.jpg' },
      tmpDir,
    );

    expect(rpcSpy).not.toHaveBeenCalled();
    expect(result).toBe(expectedPath);
  });

  it('returns null when RPC returns no data', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'signal-att-test-'));
    const channel = new SignalChannel(makeOpts());
    vi.spyOn(channel as any, 'rpcCall').mockResolvedValue(null);

    const result = await channel.downloadAttachment(
      { id: '1234', contentType: 'image/jpeg' },
      tmpDir,
    );

    expect(result).toBeNull();
  });
});
