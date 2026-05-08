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

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroupByPlatform: vi.fn(),
  setMessagingGroupAutoUrlIntake: vi.fn(),
}));

import fs from 'fs';
import { detectBareUrl, intakeUrl, resetIntakeApiKeyCache, formatIntakeReply, urlIntakeFilter } from './index.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { getMessagingGroupByPlatform, setMessagingGroupAutoUrlIntake } from '../../db/messaging-groups.js';

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
  function mg(overrides: Record<string, unknown> = {}) {
    return {
      id: 'mg-test',
      channel_type: 'sig',
      platform_id: '+12025550100',
      name: 'Joi DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      auto_url_intake: 0,
      created_at: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

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

  // ── isEnabledForEvent behavior (tested via urlIntakeFilter) ──────────────

  it('returns false when DB row missing AND env var unset (dormant)', async () => {
    (getMessagingGroupByPlatform as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    expect(await urlIntakeFilter(evt('https://x.com'))).toBe(false);
    expect(captured).toBeNull();
  });

  it('returns false when DB row has auto_url_intake:0 AND env var unset', async () => {
    (getMessagingGroupByPlatform as ReturnType<typeof vi.fn>).mockReturnValue(mg({ auto_url_intake: 0 }));
    expect(await urlIntakeFilter(evt('https://x.com'))).toBe(false);
    expect(captured).toBeNull();
  });

  it('returns true (files URL) when DB row has auto_url_intake:1', async () => {
    (getMessagingGroupByPlatform as ReturnType<typeof vi.fn>).mockReturnValue(mg({ auto_url_intake: 1 }));
    mockResponse = {
      statusCode: 200,
      body: JSON.stringify({ title: 'Test', file_path: 'test.md' }),
    };
    expect(await urlIntakeFilter(evt('https://x.com'))).toBe(true);
    expect(captured?.opts.path).toBe('/intake');
  });

  it('returns true (files URL) via env var fallback when DB row missing but env allowlist matches', async () => {
    (getMessagingGroupByPlatform as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    process.env.INTAKE_ENABLED_PLATFORM_IDS = 'sig:+12025550100';
    mockResponse = {
      statusCode: 200,
      body: JSON.stringify({ title: 'Bridge test', file_path: 'b.md' }),
    };
    expect(await urlIntakeFilter(evt('https://x.com'))).toBe(true);
    expect(captured?.opts.path).toBe('/intake');
  });

  // ── Legacy env-var behavior (unchanged) ──────────────────────────────────

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

  // ── /intake on|off slash command ─────────────────────────────────────────

  it('/intake on consumes the message, calls setMessagingGroupAutoUrlIntake(id, 1), and replies', async () => {
    const row = mg({ auto_url_intake: 0, is_group: 0 });
    (getMessagingGroupByPlatform as ReturnType<typeof vi.fn>).mockReturnValue(row);
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

    const consumed = await urlIntakeFilter(evt('/intake on'));
    expect(consumed).toBe(true);
    expect(setMessagingGroupAutoUrlIntake).toHaveBeenCalledWith('mg-test', 1);
    expect(deliver).toHaveBeenCalledTimes(1);
    const replyBody = JSON.parse(deliver.mock.calls[0]![4]);
    expect(replyBody.text).toBe('URL intake enabled for this channel.');
    // Must NOT have filed a URL
    expect(captured).toBeNull();
  });

  it('/intake off consumes the message, calls setMessagingGroupAutoUrlIntake(id, 0), and replies', async () => {
    const row = mg({ auto_url_intake: 1, is_group: 0 });
    (getMessagingGroupByPlatform as ReturnType<typeof vi.fn>).mockReturnValue(row);
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

    const consumed = await urlIntakeFilter(evt('/intake off'));
    expect(consumed).toBe(true);
    expect(setMessagingGroupAutoUrlIntake).toHaveBeenCalledWith('mg-test', 0);
    expect(deliver).toHaveBeenCalledTimes(1);
    const replyBody = JSON.parse(deliver.mock.calls[0]![4]);
    expect(replyBody.text).toBe('URL intake disabled for this channel.');
    expect(captured).toBeNull();
  });

  it('/intake on rejects with admin-required when is_group=1 (cannot verify sender in groups)', async () => {
    const row = mg({ auto_url_intake: 0, is_group: 1 });
    (getMessagingGroupByPlatform as ReturnType<typeof vi.fn>).mockReturnValue(row);
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

    const consumed = await urlIntakeFilter(evt('/intake on'));
    expect(consumed).toBe(true);
    // Must NOT have called the setter
    expect(setMessagingGroupAutoUrlIntake).not.toHaveBeenCalled();
    // Must have replied with the admin-required message
    const replyBody = JSON.parse(deliver.mock.calls[0]![4]);
    expect(replyBody.text).toMatch(/Admin required/i);
    expect(captured).toBeNull();
  });

  it('/intake on replies with "no channel registered" when messaging group is missing', async () => {
    (getMessagingGroupByPlatform as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
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

    const consumed = await urlIntakeFilter(evt('/intake on'));
    expect(consumed).toBe(true);
    expect(setMessagingGroupAutoUrlIntake).not.toHaveBeenCalled();
    const replyBody = JSON.parse(deliver.mock.calls[0]![4]);
    expect(replyBody.text).toMatch(/No channel registered/i);
  });

  it('/intake on works even when intake is currently disabled (enables it)', async () => {
    // auto_url_intake = 0 AND no env var → intake is off. /intake on should still work.
    const row = mg({ auto_url_intake: 0, is_group: 0 });
    (getMessagingGroupByPlatform as ReturnType<typeof vi.fn>).mockReturnValue(row);
    const deliver = vi.fn().mockResolvedValue('msg-1');
    (getDeliveryAdapter as ReturnType<typeof vi.fn>).mockReturnValue({ deliver });

    const consumed = await urlIntakeFilter(evt('/intake on'));
    expect(consumed).toBe(true);
    expect(setMessagingGroupAutoUrlIntake).toHaveBeenCalledWith('mg-test', 1);
  });
});
