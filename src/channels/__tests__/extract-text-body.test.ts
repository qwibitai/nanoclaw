import { describe, it, expect } from 'vitest';
import { GmailChannel } from '../gmail.js';

/**
 * Regression guard: extractTextBody must fall back to text/html when no
 * text/plain part is present. GoDaddy, DocuSign, Amazon, and many
 * banking-alert emails are HTML-only; returning '' for them caused the
 * mini-app email detail page to show "Email body could not be loaded."
 */
describe('GmailChannel.extractTextBody', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = new GmailChannel({ alias: 'test' } as any) as any;

  const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

  it('returns text/plain when present', () => {
    const out = c.extractTextBody({
      mimeType: 'text/plain',
      body: { data: b64('hello plain') },
    });
    expect(out).toBe('hello plain');
  });

  it('falls back to text/html when direct body is HTML-only', () => {
    const out = c.extractTextBody({
      mimeType: 'text/html',
      body: { data: b64('<p>hello html</p>') },
    });
    expect(out).toBe('<p>hello html</p>');
  });

  it('prefers text/plain in multipart/alternative', () => {
    const out = c.extractTextBody({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64('<p>html</p>') } },
        { mimeType: 'text/plain', body: { data: b64('plain') } },
      ],
    });
    expect(out).toBe('plain');
  });

  it('falls back to text/html inside multipart when only html is present', () => {
    const out = c.extractTextBody({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64('<p>html only</p>') } },
      ],
    });
    expect(out).toBe('<p>html only</p>');
  });

  it('recurses into nested multipart', () => {
    const out = c.extractTextBody({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/html', body: { data: b64('<p>nested</p>') } },
          ],
        },
      ],
    });
    expect(out).toBe('<p>nested</p>');
  });

  it('returns empty when no renderable body is present', () => {
    expect(c.extractTextBody(undefined)).toBe('');
    expect(c.extractTextBody({ mimeType: 'application/octet-stream' })).toBe(
      '',
    );
  });
});
