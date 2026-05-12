import { describe, it, expect } from 'vitest';
import { extractImageAttachments, categorizeMessage } from './formatter.js';
import type { MessageInRow } from './db/messages-in.js';

function row(content: object, overrides: Partial<MessageInRow> = {}): MessageInRow {
  return {
    id: 'id',
    seq: 1,
    kind: 'chat-sdk',
    timestamp: '2026-05-06T00:00:00.000Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify(content),
    ...overrides,
  } as MessageInRow;
}

describe('extractImageAttachments', () => {
  it('returns empty when there are no attachments', () => {
    expect(extractImageAttachments([row({ text: 'hi' })])).toEqual([]);
  });

  it('extracts a single jpeg image with base64 data', () => {
    const result = extractImageAttachments([
      row({
        text: 'check this',
        attachments: [{ type: 'image', mimeType: 'image/jpeg', data: 'AAAA', name: 'photo.jpg' }],
      }),
    ]);
    expect(result).toEqual([{ mediaType: 'image/jpeg', data: 'AAAA', name: 'photo.jpg' }]);
  });

  it('skips non-image attachments (audio, document)', () => {
    const result = extractImageAttachments([
      row({
        attachments: [
          { type: 'audio', mimeType: 'audio/ogg', data: 'AAAA' },
          { type: 'document', mimeType: 'application/pdf', data: 'BBBB' },
        ],
      }),
    ]);
    expect(result).toEqual([]);
  });

  it('skips images with no base64 data', () => {
    const result = extractImageAttachments([row({ attachments: [{ type: 'image', mimeType: 'image/png' }] })]);
    expect(result).toEqual([]);
  });

  it('skips unsupported image media types (svg, heic)', () => {
    const result = extractImageAttachments([
      row({
        attachments: [
          { type: 'image', mimeType: 'image/svg+xml', data: 'AAAA' },
          { type: 'image', mimeType: 'image/heic', data: 'BBBB' },
        ],
      }),
    ]);
    expect(result).toEqual([]);
  });

  it('defaults to image/jpeg when mimeType is missing', () => {
    const result = extractImageAttachments([
      row({ attachments: [{ type: 'image', data: 'AAAA', name: 'p.jpg' }] }),
    ]);
    expect(result).toEqual([{ mediaType: 'image/jpeg', data: 'AAAA', name: 'p.jpg' }]);
  });

  it('skips oversized base64 (> ~6.7MB encoded ≈ 5MB decoded)', () => {
    const huge = 'A'.repeat(7_000_000);
    const result = extractImageAttachments([
      row({ attachments: [{ type: 'image', mimeType: 'image/png', data: huge }] }),
    ]);
    expect(result).toEqual([]);
  });

  it('extracts images from multiple messages, preserving order', () => {
    const result = extractImageAttachments([
      row({ attachments: [{ type: 'image', mimeType: 'image/png', data: 'AAA', name: 'a.png' }] }),
      row({ attachments: [{ type: 'image', mimeType: 'image/webp', data: 'BBB', name: 'b.webp' }] }),
    ]);
    expect(result).toEqual([
      { mediaType: 'image/png', data: 'AAA', name: 'a.png' },
      { mediaType: 'image/webp', data: 'BBB', name: 'b.webp' },
    ]);
  });

  it('handles malformed content JSON gracefully', () => {
    const bad = { ...row({}), content: 'not valid json' } as MessageInRow;
    expect(extractImageAttachments([bad])).toEqual([]);
  });
});

describe('categorizeMessage senderId normalization', () => {
  it('WhatsApp native: composes senderId with whatsapp: prefix when content.sender lacks prefix', () => {
    const msg = row({ text: '/clear', sender: '17865189131' }, { channel_type: 'whatsapp' });
    const result = categorizeMessage(msg);
    expect(result.senderId).toBe('whatsapp:17865189131');
  });

  it('Chat SDK (no swarm): composes senderId with telegram: prefix from content.author.userId', () => {
    const msg = row(
      { text: '/clear', author: { userId: '8557164566', userName: 'jonas' } },
      { channel_type: 'telegram' },
    );
    const result = categorizeMessage(msg);
    expect(result.senderId).toBe('telegram:8557164566');
  });

  it('Chat SDK with swarm suffix: strips the suffix (telegram-finance → telegram)', () => {
    const msg = row(
      { text: '/clear', author: { userId: '8557164566', userName: 'jonas' } },
      { channel_type: 'telegram-finance' },
    );
    const result = categorizeMessage(msg);
    expect(result.senderId).toBe('telegram:8557164566');
  });

  it('already-prefixed content.senderId passes through unchanged', () => {
    const msg = row({ text: '/clear', senderId: 'telegram:8557164566' }, { channel_type: 'telegram' });
    const result = categorizeMessage(msg);
    expect(result.senderId).toBe('telegram:8557164566');
  });

  it('empty content / no sender info returns null senderId', () => {
    const msg = row({}, { channel_type: 'telegram' });
    const result = categorizeMessage(msg);
    expect(result.senderId).toBeNull();
  });
});
