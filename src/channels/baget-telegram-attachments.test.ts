import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBagetAdminServer } from '../baget-admin-server.js';
import { createBagetAgentGroup } from '../db/baget-agent-groups.js';
import { closeDb, createMessagingGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import { insertPairingToken } from '../db/baget-pairing-tokens.js';
import { bindBagetTelegramChat } from './baget-telegram-bind.js';
import { _testBuildBagetTelegramAdapter, BAGET_TELEGRAM_CHANNEL_TYPE } from './baget-telegram.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';
import {
  downloadTelegramAttachment,
  OversizedAttachmentError,
  parseTelegramAttachments,
} from './baget-telegram-attachments.js';

// ---------- Unit tests for parseTelegramAttachments ----------

describe('parseTelegramAttachments', () => {
  it('returns null for text-only messages', () => {
    expect(parseTelegramAttachments({})).toBeNull();
  });

  it('picks highest-resolution photo (last in array)', () => {
    const result = parseTelegramAttachments({
      photo: [
        { file_id: 'small', file_unique_id: 'u1', width: 100, height: 100, file_size: 5000 },
        { file_id: 'medium', file_unique_id: 'u2', width: 400, height: 400, file_size: 30000 },
        { file_id: 'large', file_unique_id: 'u3', width: 1200, height: 1200, file_size: 150000 },
      ],
    });
    expect(result).toEqual({
      kind: 'photo',
      fileId: 'large',
      mimeType: 'image/jpeg',
      sizeBytes: 150000,
    });
  });

  it('parses document with filename', () => {
    const result = parseTelegramAttachments({
      document: {
        file_id: 'doc-1',
        file_unique_id: 'ud1',
        file_size: 42000,
        mime_type: 'application/pdf',
        file_name: 'brand-guide.pdf',
      },
    });
    expect(result).toEqual({
      kind: 'document',
      fileId: 'doc-1',
      mimeType: 'application/pdf',
      originalName: 'brand-guide.pdf',
      sizeBytes: 42000,
    });
  });

  it('parses voice note', () => {
    const result = parseTelegramAttachments({
      voice: { file_id: 'voice-1', file_unique_id: 'uv1', file_size: 8000, duration: 5 },
    });
    expect(result).toEqual({
      kind: 'voice',
      fileId: 'voice-1',
      mimeType: 'audio/ogg',
      sizeBytes: 8000,
    });
  });

  it('parses video', () => {
    const result = parseTelegramAttachments({
      video: { file_id: 'vid-1', file_unique_id: 'uvi1', file_size: 500000, mime_type: 'video/mp4' },
    });
    expect(result).toEqual({
      kind: 'video',
      fileId: 'vid-1',
      mimeType: 'video/mp4',
      sizeBytes: 500000,
    });
  });

  it('parses audio with filename', () => {
    const result = parseTelegramAttachments({
      audio: {
        file_id: 'audio-1',
        file_unique_id: 'ua1',
        file_size: 3000000,
        mime_type: 'audio/mpeg',
        file_name: 'podcast.mp3',
      },
    });
    expect(result).toEqual({
      kind: 'audio',
      fileId: 'audio-1',
      mimeType: 'audio/mpeg',
      originalName: 'podcast.mp3',
      sizeBytes: 3000000,
    });
  });

  it('parses video_note', () => {
    const result = parseTelegramAttachments({
      video_note: { file_id: 'vn-1', file_unique_id: 'uvn1', file_size: 200000, length: 240 },
    });
    expect(result).toEqual({
      kind: 'video_note',
      fileId: 'vn-1',
      mimeType: 'video/mp4',
      sizeBytes: 200000,
    });
  });

  it('photo takes priority over document if both present', () => {
    const result = parseTelegramAttachments({
      photo: [{ file_id: 'ph', file_unique_id: 'up', width: 800, height: 600, file_size: 90000 }],
      document: { file_id: 'doc', file_unique_id: 'ud', file_size: 10000 },
    });
    expect(result!.kind).toBe('photo');
  });
});

// ---------- Unit tests for downloadTelegramAttachment ----------

describe('downloadTelegramAttachment', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dl-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downloads file and writes to destDir', async () => {
    const fakeContent = Buffer.from('hello world');
    const fetchImpl = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/getFile')) {
        return new Response(
          JSON.stringify({ ok: true, result: { file_path: 'photos/logo.png', file_size: fakeContent.length } }),
          { status: 200 },
        );
      }
      return new Response(fakeContent, { status: 200 });
    };

    const result = await downloadTelegramAttachment({
      botToken: 'tok',
      fileId: 'file-abc',
      destDir: tmpDir,
      fetchImpl: fetchImpl as typeof fetch,
      apiBaseUrl: 'http://tg.test',
    });

    expect(result.sizeBytes).toBe(fakeContent.length);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.readFileSync(result.filePath).toString()).toBe('hello world');
    expect(path.basename(result.filePath)).toMatch(/^file-abc-[a-f0-9]{8}\.png$/);
  });

  it('throws OversizedAttachmentError for files > 20 MB (from getFile)', async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'big.bin', file_size: 25 * 1024 * 1024 } }), {
        status: 200,
      });
    };

    await expect(
      downloadTelegramAttachment({
        botToken: 'tok',
        fileId: 'big-file',
        destDir: tmpDir,
        fetchImpl: fetchImpl as typeof fetch,
        apiBaseUrl: 'http://tg.test',
      }),
    ).rejects.toThrow(OversizedAttachmentError);
  });

  it('throws on getFile failure', async () => {
    const fetchImpl = async () => new Response('', { status: 500 });

    await expect(
      downloadTelegramAttachment({
        botToken: 'tok',
        fileId: 'x',
        destDir: tmpDir,
        fetchImpl: fetchImpl as typeof fetch,
        apiBaseUrl: 'http://tg.test',
      }),
    ).rejects.toThrow('Telegram getFile failed: 500');
  });

  it('rejects oversized download via Content-Length header BEFORE buffering body (OOM defense)', async () => {
    // Hostile/buggy upstream: getFile.file_size says 1 MB but the
    // download response declares 100 MB via Content-Length. Without
    // the pre-buffer Content-Length gate, we'd slurp 100 MB into RAM
    // before the post-buffer check could refuse — an OOM vector.
    // Verify the gate triggers BEFORE arrayBuffer() is called by
    // making the download body throw if read.
    let arrayBufferCalled = false;
    const fakeBigDownload = new Response(new Uint8Array(0), {
      status: 200,
      headers: { 'Content-Length': String(100 * 1024 * 1024) },
    });
    Object.defineProperty(fakeBigDownload, 'arrayBuffer', {
      value: async () => {
        arrayBufferCalled = true;
        throw new Error('arrayBuffer should NOT be called when Content-Length says oversized');
      },
    });

    const fetchImpl = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'big.bin', file_size: 1024 } }), {
          status: 200,
        });
      }
      return fakeBigDownload;
    };

    await expect(
      downloadTelegramAttachment({
        botToken: 'tok',
        fileId: 'oom-attempt',
        destDir: tmpDir,
        fetchImpl: fetchImpl as typeof fetch,
        apiBaseUrl: 'http://tg.test',
      }),
    ).rejects.toThrow(OversizedAttachmentError);
    expect(arrayBufferCalled).toBe(false);
  });
});

// ---------- Integration tests: processUpdate with attachments ----------

const ADMIN_TOKEN = 'test-admin-token-1234567890abcdef';
const WEBHOOK_SECRET = 'test-webhook-secret-1234567890';
const RAW_TOKEN = '0123456789abcdef0123456789abcdef';
const AGENT_GROUP_ID = 'ag-attach-test';
const AGENT_GROUP_FOLDER = 'attach-test-team';
const CHAT_ID = 777777;

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe('Baget Telegram adapter — inbound attachments', () => {
  let port: number;
  let baseUrl: string;
  let outbound: Array<{ url: string; body: unknown }>;
  let inboundEvents: Array<{ platformId: string; threadId: string | null; message: InboundMessage }>;
  let adapter: ReturnType<typeof _testBuildBagetTelegramAdapter> | null = null;
  let server: ReturnType<typeof createBagetAdminServer> | null = null;
  let tmpGroupsDir: string;
  let fileDownloadContent: Buffer;
  let getFileResponse: unknown;

  beforeEach(async () => {
    initTestDb();
    runMigrations(getDb());

    tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-groups-'));
    fileDownloadContent = Buffer.from('fake-image-data');
    getFileResponse = { ok: true, result: { file_path: 'photos/img.jpg', file_size: fileDownloadContent.length } };

    createBagetAgentGroup({
      id: AGENT_GROUP_ID,
      name: 'Attach Test',
      folder: AGENT_GROUP_FOLDER,
      user_id: 'user-1',
      company_id: 'company-1',
      baget_team_members: JSON.stringify({ cos: 'Louis', developer: 'Val' }),
      created_at: nowIso(),
    });

    insertPairingToken({
      rawToken: RAW_TOKEN,
      userId: 'user-1',
      companyId: 'company-1',
      agentGroupId: AGENT_GROUP_ID,
      expiresAt: nowIso(5 * 60 * 1000),
      createdAt: nowIso(),
    });

    outbound = [];
    inboundEvents = [];
    port = 34000 + Math.floor(Math.random() * 1000);
    baseUrl = `http://127.0.0.1:${port}`;

    adapter = _testBuildBagetTelegramAdapter({
      botToken: 'bot-token',
      webhookSecret: WEBHOOK_SECRET,
      adminToken: ADMIN_TOKEN,
      apiBaseUrl: 'https://api.telegram.test',
      _testGroupsDir: tmpGroupsDir,
      // Tight debounce so the test's 80ms post-webhook wait is enough
      // to observe the inbound event flushed through the debouncer.
      // Plain-text messages debounce; commands and attachment-bearing
      // messages bypass and route immediately. The default 1500ms is
      // fine in production but kills test latency budgets.
      inboundDebounceMs: 30,
      fetchImpl: async (url, init) => {
        const u = String(url);
        if (u.includes('/getFile')) {
          return new Response(JSON.stringify(getFileResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (u.includes('/file/bot')) {
          return new Response(fileDownloadContent, { status: 200 });
        }
        // Regular Telegram sendMessage etc.
        outbound.push({
          url: u,
          body: JSON.parse(String(init?.body ?? '{}')),
        });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const channelSetup: ChannelSetup = {
      onInbound(platformId, threadId, message) {
        inboundEvents.push({ platformId, threadId, message });
      },
      onInboundEvent() {},
      onMetadata() {},
      onAction() {},
    };

    await adapter.setup(channelSetup);

    server = createBagetAdminServer({
      port,
      adminToken: ADMIN_TOKEN,
      telegramBotUsername: 'attach_test_bot',
      telegramBotToken: 'bot-token',
      telegramApiBaseUrl: 'https://api.telegram.test',
      generateAgentGroupId: () => 'unused-in-attach-test',
      telegramFetchImpl: async (url, init) => {
        outbound.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await server.listen();

    // Pair the chat
    await sendWebhook(1, '/start ' + RAW_TOKEN);
    outbound = [];
    inboundEvents = [];
  });

  afterEach(async () => {
    if (adapter) await adapter.teardown();
    if (server) await server.close();
    closeDb();
    fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  });

  async function sendWebhook(updateId: number, text: string, extra: Record<string, unknown> = {}) {
    const body = JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId + 1000,
        from: { id: 9001, first_name: 'Sam' },
        chat: { id: CHAT_ID, type: 'private' },
        text,
        date: Math.floor(Date.now() / 1000),
        ...extra,
      },
    });
    const resp = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body,
    });
    // Give micro-task time to settle
    await new Promise((r) => setTimeout(r, 80));
    return resp;
  }

  async function sendMediaWebhook(updateId: number, mediaFields: Record<string, unknown>) {
    const body = JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId + 1000,
        from: { id: 9001, first_name: 'Sam' },
        chat: { id: CHAT_ID, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        ...mediaFields,
      },
    });
    const resp = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body,
    });
    await new Promise((r) => setTimeout(r, 80));
    return resp;
  }

  it('delivers photo attachment with caption as text', async () => {
    await sendMediaWebhook(100, {
      caption: 'Our new logo',
      photo: [
        { file_id: 'sm', file_unique_id: 'u1', width: 90, height: 90, file_size: 3000 },
        { file_id: 'lg', file_unique_id: 'u2', width: 800, height: 800, file_size: 50000 },
      ],
    });

    expect(inboundEvents).toHaveLength(1);
    const msg = inboundEvents[0]!.message;
    expect((msg.content as { text: string }).text).toBe('Our new logo');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0]!.kind).toBe('photo');
    expect(msg.attachments![0]!.mimeType).toBe('image/jpeg');
    expect(msg.attachments![0]!.platformFileId).toBe('lg');
    // File should exist on disk
    expect(fs.existsSync(msg.attachments![0]!.path)).toBe(true);
  });

  it('delivers document (PDF) attachment', async () => {
    fileDownloadContent = Buffer.from('%PDF-1.4 fake');
    getFileResponse = { ok: true, result: { file_path: 'documents/brand.pdf', file_size: fileDownloadContent.length } };

    await sendMediaWebhook(101, {
      document: {
        file_id: 'doc-brand',
        file_unique_id: 'ub1',
        file_size: 42000,
        mime_type: 'application/pdf',
        file_name: 'brand-guide.pdf',
      },
      caption: 'Here is the brand guide',
    });

    expect(inboundEvents).toHaveLength(1);
    const att = inboundEvents[0]!.message.attachments![0]!;
    expect(att.kind).toBe('document');
    expect(att.mimeType).toBe('application/pdf');
    expect(att.originalName).toBe('brand-guide.pdf');
  });

  it('delivers voice memo without text', async () => {
    fileDownloadContent = Buffer.alloc(8000);
    getFileResponse = { ok: true, result: { file_path: 'voice/note.ogg', file_size: 8000 } };

    await sendMediaWebhook(102, {
      voice: { file_id: 'voice-1', file_unique_id: 'uv1', file_size: 8000, duration: 5 },
    });

    expect(inboundEvents).toHaveLength(1);
    const msg = inboundEvents[0]!.message;
    expect((msg.content as { text: string }).text).toBe('');
    expect(msg.attachments![0]!.kind).toBe('voice');
  });

  it('rejects oversized file with user-facing error message', async () => {
    getFileResponse = { ok: true, result: { file_path: 'big.bin', file_size: 25 * 1024 * 1024 } };

    await sendMediaWebhook(103, {
      document: { file_id: 'big', file_unique_id: 'ub', file_size: 25 * 1024 * 1024 },
    });

    expect(inboundEvents).toHaveLength(0);
    const sentMsg = outbound.find((o) => o.url.includes('/sendMessage'));
    expect(sentMsg).toBeDefined();
    expect((sentMsg!.body as { text: string }).text).toContain('20 MB limit');
  });

  it('drops messages with no text and no media', async () => {
    // Service message — e.g. user joined, which has no text, no media
    const body = JSON.stringify({
      update_id: 104,
      message: {
        message_id: 2104,
        from: { id: 9001, first_name: 'Sam' },
        chat: { id: CHAT_ID, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        new_chat_members: [{ id: 9001, first_name: 'Sam' }],
      },
    });
    await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body,
    });
    await new Promise((r) => setTimeout(r, 80));

    expect(inboundEvents).toHaveLength(0);
  });

  it('still handles plain text messages correctly', async () => {
    await sendWebhook(105, 'Hello team!');

    expect(inboundEvents).toHaveLength(1);
    const msg = inboundEvents[0]!.message;
    expect((msg.content as { text: string }).text).toBe('Hello team!');
    expect(msg.attachments).toBeUndefined();
  });
});
