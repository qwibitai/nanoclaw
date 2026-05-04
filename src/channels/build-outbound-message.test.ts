/**
 * Unit tests for the OutboundMessage construction helper used by the
 * host's delivery bridge. The single most important guarantee is the
 * attachments lift — without it, path-based media from MCP tools
 * (canonical example: `baget_send_document_file` for the deck-send
 * flow) silently drops on every channel that reads `message.attachments`
 * (Telegram today; Slack/WhatsApp planned).
 */
import { describe, expect, it } from 'vitest';

import { buildOutboundMessage } from './build-outbound-message.js';
import type { OutboundFile } from './adapter.js';

describe('buildOutboundMessage', () => {
  it('passes kind + parsed content through unchanged when there are no attachments or files', () => {
    const out = buildOutboundMessage('chat', { text: 'hello' }, undefined);
    expect(out.kind).toBe('chat');
    expect(out.content).toEqual({ text: 'hello' });
    expect(out.attachments).toBeUndefined();
    expect(out.files).toBeUndefined();
  });

  it('lifts content.attachments onto OutboundMessage.attachments — the deck-send fix', () => {
    // This is the single regression test that locks in the
    // production deck-send fix. Without the lift, the Telegram
    // adapter's `message.attachments ?? []` reads empty and the
    // file silently drops.
    const attachments = [
      {
        kind: 'document' as const,
        path: '/host/sessions/ag-1/sess-1/outbox/msg-1/pitch-deck.pdf',
        filename: 'pitch-deck.pdf',
        caption: "Here's the deck.",
      },
    ];
    const out = buildOutboundMessage('chat', { text: '', attachments }, undefined);
    expect(out.attachments).toEqual(attachments);
    expect(out.content).toEqual({ text: '', attachments });
  });

  it('lifts a multi-attachment array, preserving order', () => {
    const attachments = [
      { kind: 'photo' as const, path: '/p/hero.png', caption: 'Hero v3' },
      { kind: 'document' as const, path: '/p/bp.pdf', filename: 'bp.pdf' },
    ];
    const out = buildOutboundMessage('chat', { text: '', attachments }, undefined);
    expect(out.attachments).toHaveLength(2);
    expect(out.attachments?.[0].kind).toBe('photo');
    expect(out.attachments?.[1].kind).toBe('document');
  });

  it('omits attachments key when content.attachments is missing — adapter does the `?? []` fallback', () => {
    // Setting attachments: undefined vs omitting the key matters for
    // the adapter's `message.attachments ?? []` short-circuit and for
    // serialization shape parity with the pre-lift behavior.
    const out = buildOutboundMessage('chat', { text: 'plain' }, undefined);
    expect('attachments' in out).toBe(false);
  });

  it('omits attachments when content.attachments is not an array (defensive)', () => {
    // Malformed agent payloads happen — guard against accidental
    // `attachments: "pitch.pdf"` (string) or `attachments: { ... }`
    // (object). Per-item validation is the adapter's job, but the
    // outer-shape check belongs here so we don't hand a non-iterable
    // to a `for…of`.
    const out = buildOutboundMessage('chat', { text: '', attachments: 'pitch.pdf' }, undefined);
    expect(out.attachments).toBeUndefined();
  });

  it('omits attachments when content is null / non-object — guards against a stringly-typed content', () => {
    const fromString = buildOutboundMessage('chat', 'just a string', undefined);
    expect(fromString.attachments).toBeUndefined();
    expect(fromString.content).toBe('just a string');

    const fromNull = buildOutboundMessage('chat', null, undefined);
    expect(fromNull.attachments).toBeUndefined();
  });

  it('passes legacy buffer-based files through alongside attachments', () => {
    // Legacy `files` (used by core's send_file tool) and modern
    // `attachments` (used by send_document_file) coexist. The Telegram
    // adapter reads only attachments today, but the bridge keeps both
    // pass-throughs so any future adapter that wants the buffer-based
    // contract still works.
    const files: OutboundFile[] = [{ filename: 'legacy.txt', data: Buffer.from('legacy') }];
    const attachments = [{ kind: 'document' as const, path: '/p/new.pdf', filename: 'new.pdf' }];
    const out = buildOutboundMessage('chat', { text: '', attachments }, files);
    expect(out.files).toEqual(files);
    expect(out.attachments).toEqual(attachments);
  });

  it('omits files key when files is undefined (matches pre-refactor wire shape)', () => {
    const out = buildOutboundMessage('chat', { text: 'no files' }, undefined);
    expect('files' in out).toBe(false);
  });
});
