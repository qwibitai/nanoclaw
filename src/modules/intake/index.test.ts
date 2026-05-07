import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: { ...actual, readFileSync: vi.fn(), existsSync: vi.fn(() => true) },
    readFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: vi.fn(() => null),
}));

vi.mock('../../router.js', () => ({
  setInboundContentFilter: vi.fn(),
}));

import fs from 'fs';
import { detectBareUrl, intakeUrl, resetIntakeApiKeyCache, formatIntakeReply, urlIntakeFilter } from './index.js';
import { getDeliveryAdapter } from '../../delivery.js';

const CREDS_WITH_INTAKE = `
AMPLIFIERD_API_KEY=amp-key
AMPLIFIERD_BASE_URL=http://h:1
INTAKE_API_KEY=intake-secret-abc
`;

const CREDS_WITHOUT_INTAKE = `
AMPLIFIERD_API_KEY=amp-key
AMPLIFIERD_BASE_URL=http://h:1
`;

let captured: { opts: https.RequestOptions; body: string } | null = null;
let mockResponse: { statusCode: number; body: string } | null = null;
let mockError: Error | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  resetIntakeApiKeyCache();
  (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(CREDS_WITH_INTAKE);
  captured = null;
  mockResponse = null;
  mockError = null;

  vi.spyOn(https, 'request').mockImplementation(((opts: https.RequestOptions, cb?: (res: unknown) => void) => {
    const req = new EventEmitter() as unknown as {
      write: (s: string) => void;
      end: () => void;
      destroy: () => void;
      on: (e: string, l: (...a: unknown[]) => void) => void;
      emit: (e: string, ...a: unknown[]) => boolean;
    };
    captured = { opts, body: '' };
    req.write = (chunk: string) => {
      captured!.body += chunk;
    };
    req.end = () => {
      setImmediate(() => {
        if (mockError) {
          req.emit('error', mockError);
          return;
        }
        if (mockResponse && cb) {
          const res = new EventEmitter() as unknown as {
            statusCode: number;
            on: (e: string, l: (...a: unknown[]) => void) => void;
            emit: (e: string, ...a: unknown[]) => boolean;
          };
          res.statusCode = mockResponse.statusCode;
          cb(res);
          setImmediate(() => {
            res.emit('data', Buffer.from(mockResponse!.body));
            res.emit('end');
          });
        }
      });
    };
    req.destroy = () => {
      /* noop for test */
    };
    return req;
  }) as never);
});

afterEach(() => {
  delete process.env.INTAKE_ENABLED_PLATFORM_IDS;
  delete process.env.INTAKE_SPRITE_URL;
});

describe('detectBareUrl', () => {
  it('returns the URL for a single-token http URL', () => {
    expect(detectBareUrl('http://example.com')).toBe('http://example.com');
  });
  it('returns the URL for a single-token https URL', () => {
    expect(detectBareUrl('https://x.com/foo/status/123')).toBe('https://x.com/foo/status/123');
  });
  it('strips surrounding whitespace', () => {
    expect(detectBareUrl('  https://example.com  ')).toBe('https://example.com');
    expect(detectBareUrl('\n\thttps://x.com\n')).toBe('https://x.com');
  });
  it('rejects URL with leading text', () => {
    expect(detectBareUrl('check this https://x.com')).toBeNull();
  });
  it('rejects URL with trailing text', () => {
    expect(detectBareUrl('https://x.com extra text')).toBeNull();
  });
  it('rejects two URLs in one message', () => {
    expect(detectBareUrl('https://a.com https://b.com')).toBeNull();
  });
  it('rejects empty / whitespace-only', () => {
    expect(detectBareUrl('')).toBeNull();
    expect(detectBareUrl('   \n  ')).toBeNull();
  });
  it('rejects non-http schemes', () => {
    expect(detectBareUrl('ftp://example.com')).toBeNull();
    expect(detectBareUrl('mailto:a@b.com')).toBeNull();
    expect(detectBareUrl('javascript:alert(1)')).toBeNull();
  });
  it('rejects bare domain without scheme', () => {
    expect(detectBareUrl('example.com')).toBeNull();
  });
});

describe('formatIntakeReply', () => {
  it('formats a successful response with all fields', () => {
    expect(
      formatIntakeReply({
        title: 'Some article',
        classification: 'research',
        file_path: 'agents/curator/extractions/foo.md',
      }),
    ).toBe('Filed [research]: Some article\n→ agents/curator/extractions/foo.md');
  });
  it('omits classification when missing', () => {
    expect(formatIntakeReply({ title: 'Some article', file_path: 'p.md' })).toBe('Filed: Some article\n→ p.md');
  });
  it('omits file_path when missing', () => {
    expect(formatIntakeReply({ title: 't', classification: 'c' })).toBe('Filed [c]: t');
  });
  it('falls back to (untitled) when title missing', () => {
    expect(formatIntakeReply({ classification: 'c' })).toBe('Filed [c]: (untitled)');
  });
  it('formats an error response', () => {
    expect(formatIntakeReply({ error: 'sprite down' })).toBe("Couldn't auto-file URL: sprite down");
  });
  it('truncates long error messages', () => {
    const long = 'x'.repeat(300);
    const out = formatIntakeReply({ error: long });
    // Prefix "Couldn't auto-file URL: " (24 chars) + 200-char slice of error = 224
    expect(out.length).toBeLessThan(230);
    expect(out).toMatch(/^Couldn't auto-file URL:/);
  });
});

describe('intakeUrl', () => {
  it('POSTs to /intake with X-API-Key and url body', async () => {
    mockResponse = {
      statusCode: 200,
      body: JSON.stringify({ status: 'filed', title: 't', file_path: 'p.md' }),
    };
    const out = await intakeUrl('https://x.com/article');
    expect(out).toEqual({ status: 'filed', title: 't', file_path: 'p.md' });
    expect(captured?.opts.path).toBe('/intake');
    expect((captured?.opts.headers as Record<string, unknown>)?.['X-API-Key']).toBe('intake-secret-abc');
    expect(JSON.parse(captured!.body)).toEqual({ url: 'https://x.com/article' });
  });

  it('forwards optional hint and domain', async () => {
    mockResponse = { statusCode: 200, body: '{"status":"ok"}' };
    await intakeUrl('https://x.com', { hint: 'tech', domain: 'eng' });
    expect(JSON.parse(captured!.body)).toEqual({
      url: 'https://x.com',
      hint: 'tech',
      domain: 'eng',
    });
  });

  it('returns { error } when sprite returns non-2xx', async () => {
    mockResponse = { statusCode: 500, body: 'internal' };
    const out = await intakeUrl('https://x.com');
    expect(out.error).toMatch(/HTTP 500/);
  });

  it('returns { error } on network failure', async () => {
    mockError = new Error('connection refused');
    const out = await intakeUrl('https://x.com');
    expect(out.error).toMatch(/network error/);
  });

  it('returns { error } on non-JSON body', async () => {
    mockResponse = { statusCode: 200, body: '<html>oops</html>' };
    const out = await intakeUrl('https://x.com');
    expect(out.error).toMatch(/non-JSON/);
  });

  it('returns { error } when INTAKE_API_KEY missing from creds', async () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(CREDS_WITHOUT_INTAKE);
    const out = await intakeUrl('https://x.com');
    expect(out.error).toMatch(/INTAKE_API_KEY not found/);
  });
});

describe('urlIntakeFilter', () => {
  function evt(
    text: string,
    channelType = 'sig',
    platformId = '+12025550100',
  ): {
    channelType: string;
    platformId: string;
    threadId: null;
    message: { id: string; kind: 'chat'; content: string; timestamp: string };
  } {
    return {
      channelType,
      platformId,
      threadId: null,
      message: {
        id: 'm1',
        kind: 'chat',
        content: JSON.stringify({ text }),
        timestamp: '2026-05-06T00:00:00Z',
      },
    };
  }

  it('returns false when env allowlist is empty (dormant)', async () => {
    expect(await urlIntakeFilter(evt('https://x.com'))).toBe(false);
    expect(captured).toBeNull();
  });

  it('returns false when channel not in allowlist', async () => {
    process.env.INTAKE_ENABLED_PLATFORM_IDS = 'sig:+18005551212';
    expect(await urlIntakeFilter(evt('https://x.com', 'sig', '+12025550100'))).toBe(false);
    expect(captured).toBeNull();
  });

  it('returns false when text has surrounding content', async () => {
    process.env.INTAKE_ENABLED_PLATFORM_IDS = 'sig:+12025550100';
    expect(await urlIntakeFilter(evt('check this out https://x.com'))).toBe(false);
    expect(captured).toBeNull();
  });

  it('returns false on chat-sdk messages', async () => {
    process.env.INTAKE_ENABLED_PLATFORM_IDS = 'sig:+12025550100';
    const e = evt('https://x.com');
    e.message.kind = 'chat-sdk' as 'chat';
    expect(await urlIntakeFilter(e)).toBe(false);
  });

  it('files URL and replies via delivery adapter on match', async () => {
    process.env.INTAKE_ENABLED_PLATFORM_IDS = 'sig:+12025550100';
    mockResponse = {
      statusCode: 200,
      body: JSON.stringify({ title: 'A title', classification: 'note', file_path: 'a.md' }),
    };
    const deliver = vi
      .fn<
        (
          channelType: string,
          platformId: string,
          threadId: string | null,
          kind: string,
          content: string,
        ) => Promise<string>
      >()
      .mockResolvedValue('msg-1');
    (getDeliveryAdapter as ReturnType<typeof vi.fn>).mockReturnValue({ deliver });

    const consumed = await urlIntakeFilter(evt('https://x.com/abc'));
    expect(consumed).toBe(true);
    expect(captured?.opts.path).toBe('/intake');
    expect(deliver).toHaveBeenCalledTimes(1);
    const call = deliver.mock.calls[0]!;
    expect(call[0]).toBe('sig');
    expect(call[1]).toBe('+12025550100');
    expect(call[2]).toBeNull();
    expect(call[3]).toBe('chat');
    expect(JSON.parse(call[4])).toEqual({
      text: 'Filed [note]: A title\n→ a.md',
    });
  });

  it('still consumes the message even if delivery adapter is null', async () => {
    process.env.INTAKE_ENABLED_PLATFORM_IDS = 'sig:+12025550100';
    mockResponse = {
      statusCode: 200,
      body: JSON.stringify({ title: 't', file_path: 'p.md' }),
    };
    (getDeliveryAdapter as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(await urlIntakeFilter(evt('https://x.com'))).toBe(true);
  });

  it('still consumes when sprite errors — replies with error message', async () => {
    process.env.INTAKE_ENABLED_PLATFORM_IDS = 'sig:+12025550100';
    mockResponse = { statusCode: 500, body: 'broken' };
    const deliver = vi
      .fn<
        (
          channelType: string,
          platformId: string,
          threadId: string | null,
          kind: string,
          content: string,
        ) => Promise<string>
      >()
      .mockResolvedValue('msg-1');
    (getDeliveryAdapter as ReturnType<typeof vi.fn>).mockReturnValue({ deliver });
    expect(await urlIntakeFilter(evt('https://x.com'))).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    const call = deliver.mock.calls[0]!;
    expect(JSON.parse(call[4]).text).toMatch(/Couldn't auto-file/);
  });
});
