/**
 * Regression tests for the v1 WhatsApp sendFile hang.
 *
 * Background (see beads nanoclaw-dou): in v1 (Baileys 6.6.0), passing
 *   { document: { url: <local file path> } }
 * to `sock.sendMessage` deterministically hung — Baileys logged "fetched
 * media stream" and never resolved. Workaround: pre-buffer the file and
 * pass `{ document: <Buffer> }` directly. v2 was rewritten to do this
 * (Baileys is now 7.x and the v1 file is gone), but we keep this test
 * as a guard against anyone re-introducing a `{ url: ... }` payload to
 * `sock.sendMessage` via `buildMediaMessage`.
 */
import { describe, expect, it } from 'vitest';

import { buildMediaMessage } from './whatsapp.js';

const SAMPLE = Buffer.from('hello-bytes');

function payloadOf(msg: Record<string, unknown>): unknown {
  return msg.document ?? msg.image ?? msg.video ?? msg.audio;
}

describe('buildMediaMessage — never emits {url:...} (Baileys 6.6.0 hang regression)', () => {
  for (const [label, filename, ext] of [
    ['image (jpg)', 'photo.jpg', '.jpg'],
    ['image (png)', 'shot.png', '.png'],
    ['video', 'clip.mp4', '.mp4'],
    ['audio (mp3)', 'song.mp3', '.mp3'],
    ['audio (opus)', 'voice.opus', '.opus'],
    ['document (pdf)', 'doc.pdf', '.pdf'],
    ['document (unknown ext)', 'thing.xyz', '.xyz'],
    ['document (no ext)', 'README', ''],
  ] as const) {
    it(`${label}: payload is a Buffer, not {url:...}`, () => {
      const msg = buildMediaMessage(SAMPLE, filename, ext, 'caption');
      const payload = payloadOf(msg);

      // The critical invariant: the payload IS the Buffer we passed in.
      expect(Buffer.isBuffer(payload)).toBe(true);
      expect(payload).toBe(SAMPLE);

      // The bug-shape: { document: { url: ... } } or any payload containing a `url` key.
      expect(payload && typeof payload === 'object' && !Buffer.isBuffer(payload) && 'url' in payload).toBeFalsy();
    });
  }

  it('document branch sets fileName + mimetype (sanity)', () => {
    const msg = buildMediaMessage(SAMPLE, 'thing.pdf', '.pdf', undefined);
    expect(msg.fileName).toBe('thing.pdf');
    expect(typeof msg.mimetype).toBe('string');
  });

  it('caption is preserved on captioned types and absent on audio', () => {
    expect(buildMediaMessage(SAMPLE, 'photo.jpg', '.jpg', 'hi').caption).toBe('hi');
    expect(buildMediaMessage(SAMPLE, 'clip.mp4', '.mp4', 'hi').caption).toBe('hi');
    expect(buildMediaMessage(SAMPLE, 'doc.pdf', '.pdf', 'hi').caption).toBe('hi');
    // Baileys audio messages don't carry captions; we explicitly omit it.
    expect(buildMediaMessage(SAMPLE, 'song.mp3', '.mp3', 'hi').caption).toBeUndefined();
  });
});
