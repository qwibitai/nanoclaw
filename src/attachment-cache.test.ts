import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cacheAttachmentsForMessage } from './attachment-cache.js';

describe('cacheAttachmentsForMessage', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('downloads image segments into the group attachment cache', async () => {
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cache-'));
    tempDirs.push(groupDir);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (key: string) => (key === 'content-type' ? 'image/png' : null),
        },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
      }),
    );

    const result = await cacheAttachmentsForMessage({
      groupDir,
      messageId: 'msg-1',
      content: '',
      metadata: {
        segments: [{ type: 'image', url: 'https://example.com/photo.png' }],
      },
    });

    const attachments = result.metadata?.attachments as
      | Array<Record<string, unknown>>
      | undefined;
    expect(attachments).toHaveLength(1);
    expect(String(attachments?.[0].local_path || '')).toContain(
      '.attachments/',
    );
    expect(result.synthesizedContent).toBe('[User sent 1 image attachment]');

    const cacheDir = path.join(groupDir, '.attachments');
    expect(fs.readdirSync(cacheDir)).toHaveLength(1);
  });

  it('keeps message text when attachments exist', async () => {
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cache-'));
    tempDirs.push(groupDir);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      }),
    );

    const result = await cacheAttachmentsForMessage({
      groupDir,
      messageId: 'msg-2',
      content: 'look at this',
      metadata: {
        segments: [
          { type: 'image', image: { url: 'https://example.com/photo.jpg' } },
        ],
      },
    });

    expect(result.synthesizedContent).toBeUndefined();
    const attachments = result.metadata?.attachments as
      | Array<Record<string, unknown>>
      | undefined;
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0].mime_type).toBe('image/jpeg');
  });
});
