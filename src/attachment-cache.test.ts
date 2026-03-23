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
    expect(fs.readdirSync(cacheDir)[0]).toMatch(/\.png$/);
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

  it('sniffs jpeg files when content-type and url extension are missing', async () => {
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cache-'));
    tempDirs.push(groupDir);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () =>
          Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]).buffer,
      }),
    );

    const result = await cacheAttachmentsForMessage({
      groupDir,
      messageId: 'msg-3',
      content: '',
      metadata: {
        segments: [{ type: 'image', url: 'https://example.com/download?id=1' }],
      },
    });

    const attachments = result.metadata?.attachments as
      | Array<Record<string, unknown>>
      | undefined;
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0].mime_type).toBe('image/jpeg');

    const cacheDir = path.join(groupDir, '.attachments');
    expect(fs.readdirSync(cacheDir)[0]).toMatch(/\.jpg$/);
  });

  it('downloads image segments nested inside reply metadata', async () => {
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
      messageId: 'msg-4',
      content: '',
      metadata: {
        reply: {
          message_id: 'quoted-1',
          sender_name: 'Bob',
          segments: [
            {
              type: 'image',
              image: { url: 'https://example.com/replied.png' },
            },
          ],
        },
      },
    });

    const attachments = result.metadata?.attachments as
      | Array<Record<string, unknown>>
      | undefined;
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0].original_url).toBe(
      'https://example.com/replied.png',
    );
    expect(result.synthesizedContent).toBe('[User sent 1 image attachment]');
  });

  it('deduplicates identical image bytes across different urls', async () => {
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cache-'));
    tempDirs.push(groupDir);

    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (key: string) => (key === 'content-type' ? 'image/png' : null),
        },
        arrayBuffer: async () => imageBytes.buffer,
      }),
    );

    const first = await cacheAttachmentsForMessage({
      groupDir,
      messageId: 'msg-6',
      content: '',
      metadata: {
        segments: [{ type: 'image', url: 'https://example.com/photo-a.png' }],
      },
    });
    const second = await cacheAttachmentsForMessage({
      groupDir,
      messageId: 'msg-7',
      content: '',
      metadata: {
        segments: [
          { type: 'image', url: 'https://cdn.example.org/photo-b.png' },
        ],
      },
    });

    const firstAttachment = (
      first.metadata?.attachments as Array<Record<string, unknown>>
    )[0];
    const secondAttachment = (
      second.metadata?.attachments as Array<Record<string, unknown>>
    )[0];

    expect(firstAttachment.file_name).toBe(secondAttachment.file_name);
    expect(firstAttachment.local_path).toBe(secondAttachment.local_path);

    const cacheDir = path.join(groupDir, '.attachments');
    expect(fs.readdirSync(cacheDir)).toHaveLength(1);
  });

  it('finds quoted images nested in arbitrary reply metadata branches', async () => {
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
      messageId: 'msg-5',
      content: 'please inspect the quote',
      metadata: {
        source: 'astrbot',
        reply: {
          message_id: 'quoted-2',
          raw: {
            quoted_message: {
              elements: [
                {
                  type: 'image',
                  data: {
                    src: 'https://example.com/nested-quote.png',
                  },
                },
              ],
            },
          },
        },
      },
    });

    const attachments = result.metadata?.attachments as
      | Array<Record<string, unknown>>
      | undefined;
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0].original_url).toBe(
      'https://example.com/nested-quote.png',
    );
    expect(result.synthesizedContent).toBeUndefined();
  });
});
