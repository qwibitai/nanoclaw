import { describe, it, expect, beforeEach } from 'vitest';

import { buildAttachmentFilename, mimeToExt } from './utils.js';
import { _initTestDatabase, storeMessage, getMessagesSince, storeChatMetadata } from './db.js';

describe('mimeToExt', () => {
  it('returns known extensions', () => {
    expect(mimeToExt('image/jpeg')).toBe('jpg');
    expect(mimeToExt('audio/mp4')).toBe('m4a');
  });
  it('returns bin for unknown types', () => {
    expect(mimeToExt('application/x-custom')).toBe('bin');
  });
});

describe('buildAttachmentFilename', () => {
  it('prefixes ID when filename provided', () => {
    const result = buildAttachmentFilename({ id: 'abc123', contentType: 'image/jpeg', filename: 'photo.jpg' });
    expect(result).toBe('abc123-photo.jpg');
  });
  it('uses sanitized ID when ID has extension', () => {
    const result = buildAttachmentFilename({ id: 'pfZsYQLdsQM4.webp', contentType: 'image/webp' });
    expect(result).toBe('pfZsYQLdsQM4.webp');
  });
  it('appends mime extension when no filename and no extension in ID', () => {
    const result = buildAttachmentFilename({ id: 'abc123', contentType: 'image/png' });
    expect(result).toBe('abc123-attachment.png');
  });
  it('sanitizes special characters in ID and filename', () => {
    const result = buildAttachmentFilename({ id: 'abc/123', contentType: 'image/jpeg', filename: 'my photo!.jpg' });
    expect(result).toBe('abc_123-my_photo_.jpg');
  });
});

describe('db round-trip', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores attachments_json and deserializes on read', () => {
    storeChatMetadata('g@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'g@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'check this',
      timestamp: '2024-01-01T00:00:01.000Z',
      attachments: [{ id: 'att-1', contentType: 'image/jpeg', size: 12345 }],
    });

    const rows = getMessagesSince('g@g.us', '2024-01-01T00:00:00.000Z', 'Bot');
    expect(rows).toHaveLength(1);
    expect(rows[0].attachments).toEqual([{ id: 'att-1', contentType: 'image/jpeg', size: 12345 }]);
  });

  it('handles missing attachments_json gracefully', () => {
    storeChatMetadata('g@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-2',
      chat_jid: 'g@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'no attachments',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    const rows = getMessagesSince('g@g.us', '2024-01-01T00:00:00.000Z', 'Bot');
    expect(rows).toHaveLength(1);
    expect(rows[0].attachments).toBeUndefined();
  });
});

describe('orchestrator download loop', () => {
  it.todo('calls downloadAttachment for each attachment');
  it.todo('skips attachment with localPath already set (idempotent)');
  it.todo('logs warning and continues if downloadAttachment throws');
  it.todo('appends [file: ...] lines to message content');
  it.todo('does not modify content if no downloads succeeded');
  it.todo('skips download loop entirely for channels without downloadAttachment');
});
