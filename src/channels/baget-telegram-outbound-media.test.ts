/**
 * Tests for sendBagetBotPhoto and sendBagetBotDocument — the outbound
 * media primitives the MCP send-document tool calls directly.
 *
 * These helpers mirror the sendBagetBotMessage contract:
 *   - happy path: { ok: true, messageId }
 *   - Telegram 403: { ok: false, founderActionRequired: true }
 *   - transport throw: { ok: false, founderActionRequired: false }
 *   - missing file: throws before fetch (caller validates paths)
 *
 * deliver() wiring is intentionally NOT tested here — that is PR #7's scope.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { sendBagetBotPhoto, sendBagetBotDocument } from './baget-telegram-bind.js';
import { _testBuildBagetTelegramAdapter } from './baget-telegram.js';

// ── Fixture helpers ──

function fakeFetchOk(messageId = 42): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 }),
  ) as unknown as typeof fetch;
}

function fakeFetchTelegramError(status: number, description: string): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify({ ok: false, description }), { status }),
  ) as unknown as typeof fetch;
}

function fakeFetchTransportThrow(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
}

type MockCalls = { mock: { calls: [string, RequestInit][] } };
function mockCalls(fn: typeof fetch): [string, RequestInit][] {
  return (fn as unknown as MockCalls).mock.calls;
}

// ── Shared temp dir for file fixtures ──

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'baget-tg-media-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── sendBagetBotPhoto ──

describe('sendBagetBotPhoto', () => {
  it('happy path: correct URL, FormData body, success result', async () => {
    const photoPath = join(tmpDir, 'screenshot.jpg');
    writeFileSync(photoPath, Buffer.from('fake-jpeg-data'));

    const fetchImpl = fakeFetchOk(99);
    const result = await sendBagetBotPhoto({
      botToken: 'tok',
      chatId: 12345,
      photoPath,
      agentGroupId: 'ag-test',
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, messageId: '99' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = mockCalls(fetchImpl)[0]!;
    expect(url).toBe('https://api.telegram.org/bottok/sendPhoto');
    expect(init.method).toBe('POST');

    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('chat_id')).toBe('12345');
    expect(body.get('photo')).not.toBeNull();
  });

  it('includes caption when provided', async () => {
    const photoPath = join(tmpDir, 'screen-cap.png');
    writeFileSync(photoPath, Buffer.from('png-bytes'));

    const fetchImpl = fakeFetchOk(7);
    await sendBagetBotPhoto({
      botToken: 'tok',
      chatId: 1,
      photoPath,
      caption: 'Website screenshot',
      agentGroupId: 'ag-1',
      fetchImpl,
    });

    const body = mockCalls(fetchImpl)[0]![1].body as FormData;
    expect(body.get('caption')).toBe('Website screenshot');
  });

  it('apiBaseUrl override is respected', async () => {
    const photoPath = join(tmpDir, 'p.jpg');
    writeFileSync(photoPath, Buffer.from('x'));

    const fetchImpl = fakeFetchOk();
    await sendBagetBotPhoto({
      botToken: 'tk',
      chatId: 9,
      photoPath,
      agentGroupId: 'ag-2',
      apiBaseUrl: 'https://test-tg.example.com',
      fetchImpl,
    });

    const [url] = mockCalls(fetchImpl)[0]!;
    expect(url).toContain('test-tg.example.com');
  });

  it("403 can't initiate conversation → founderActionRequired: true", async () => {
    const photoPath = join(tmpDir, 'p403.jpg');
    writeFileSync(photoPath, Buffer.from('x'));

    const fetchImpl = fakeFetchTelegramError(403, "Forbidden: bot can't initiate conversation with a user");
    const result = await sendBagetBotPhoto({
      botToken: 'tok',
      chatId: 99,
      photoPath,
      agentGroupId: 'ag-test',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, founderActionRequired: true });
  });

  it('403 chat not found → founderActionRequired: true', async () => {
    const photoPath = join(tmpDir, 'p403b.jpg');
    writeFileSync(photoPath, Buffer.from('x'));

    const fetchImpl = fakeFetchTelegramError(403, 'Bad Request: chat not found');
    const result = await sendBagetBotPhoto({
      botToken: 'tok',
      chatId: 99,
      photoPath,
      agentGroupId: 'ag-test',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, founderActionRequired: true });
  });

  it('transport throw → ok: false, founderActionRequired: false', async () => {
    const photoPath = join(tmpDir, 'p-throw.jpg');
    writeFileSync(photoPath, Buffer.from('x'));

    const fetchImpl = fakeFetchTransportThrow();
    const result = await sendBagetBotPhoto({
      botToken: 'tok',
      chatId: 99,
      photoPath,
      agentGroupId: 'ag-test',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, founderActionRequired: false });
  });

  it('file not found → throws before fetch is called', async () => {
    const fetchImpl = fakeFetchOk();
    await expect(
      sendBagetBotPhoto({
        botToken: 'tok',
        chatId: 1,
        photoPath: '/nonexistent/path/photo.jpg',
        agentGroupId: 'ag-test',
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ── sendBagetBotDocument ──

describe('sendBagetBotDocument', () => {
  it('happy path: correct URL, FormData body, success result', async () => {
    const documentPath = join(tmpDir, 'report.pdf');
    writeFileSync(documentPath, Buffer.from('%PDF-fake'));

    const fetchImpl = fakeFetchOk(55);
    const result = await sendBagetBotDocument({
      botToken: 'tok',
      chatId: 777,
      documentPath,
      agentGroupId: 'ag-test',
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, messageId: '55' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = mockCalls(fetchImpl)[0]!;
    expect(url).toBe('https://api.telegram.org/bottok/sendDocument');
    expect(init.method).toBe('POST');

    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('chat_id')).toBe('777');
    expect(body.get('document')).not.toBeNull();
  });

  it('uses basename(documentPath) as display name by default', async () => {
    const documentPath = join(tmpDir, 'prospects.csv');
    writeFileSync(documentPath, Buffer.from('name,email\n'));

    const fetchImpl = fakeFetchOk();
    await sendBagetBotDocument({
      botToken: 'tok',
      chatId: 1,
      documentPath,
      agentGroupId: 'ag-1',
      fetchImpl,
    });

    const body = mockCalls(fetchImpl)[0]![1].body as FormData;
    const doc = body.get('document') as File;
    expect(doc.name).toBe('prospects.csv');
  });

  it('filename override replaces display name', async () => {
    const documentPath = join(tmpDir, 'tmp-abc123.pdf');
    writeFileSync(documentPath, Buffer.from('pdf'));

    const fetchImpl = fakeFetchOk();
    await sendBagetBotDocument({
      botToken: 'tok',
      chatId: 1,
      documentPath,
      filename: 'Q1-email-campaign.pdf',
      agentGroupId: 'ag-1',
      fetchImpl,
    });

    const body = mockCalls(fetchImpl)[0]![1].body as FormData;
    const doc = body.get('document') as File;
    expect(doc.name).toBe('Q1-email-campaign.pdf');
  });

  it('includes caption when provided', async () => {
    const documentPath = join(tmpDir, 'data.csv');
    writeFileSync(documentPath, Buffer.from('a,b\n'));

    const fetchImpl = fakeFetchOk();
    await sendBagetBotDocument({
      botToken: 'tok',
      chatId: 1,
      documentPath,
      caption: 'Prospect CSV for this batch',
      agentGroupId: 'ag-1',
      fetchImpl,
    });

    const body = mockCalls(fetchImpl)[0]![1].body as FormData;
    expect(body.get('caption')).toBe('Prospect CSV for this batch');
  });

  it('403 → founderActionRequired: true', async () => {
    const documentPath = join(tmpDir, 'd403.pdf');
    writeFileSync(documentPath, Buffer.from('x'));

    const fetchImpl = fakeFetchTelegramError(403, "Forbidden: bot can't initiate conversation with a user");
    const result = await sendBagetBotDocument({
      botToken: 'tok',
      chatId: 99,
      documentPath,
      agentGroupId: 'ag-test',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, founderActionRequired: true });
  });

  it('transport throw → ok: false, founderActionRequired: false', async () => {
    const documentPath = join(tmpDir, 'd-throw.pdf');
    writeFileSync(documentPath, Buffer.from('x'));

    const fetchImpl = fakeFetchTransportThrow();
    const result = await sendBagetBotDocument({
      botToken: 'tok',
      chatId: 99,
      documentPath,
      agentGroupId: 'ag-test',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, founderActionRequired: false });
  });

  it('file not found → throws before fetch is called', async () => {
    const fetchImpl = fakeFetchOk();
    await expect(
      sendBagetBotDocument({
        botToken: 'tok',
        chatId: 1,
        documentPath: '/nonexistent/path/report.pdf',
        agentGroupId: 'ag-test',
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ── Capability flags ──

describe('Telegram adapter mediaSupport capability flags', () => {
  it('photo and document are true with Telegram Bot API 50 MB limit', () => {
    const adapter = _testBuildBagetTelegramAdapter({
      botToken: 'test-token',
      webhookSecret: 'secret-secret-secret',
      adminToken: 'admin-admin-admin',
    });

    expect(adapter.mediaSupport).toBeDefined();
    expect(adapter.mediaSupport?.photo).toBe(true);
    expect(adapter.mediaSupport?.document).toBe(true);
    expect(adapter.mediaSupport?.maxBytesPerAttachment).toBe(50 * 1024 * 1024);
  });
});
