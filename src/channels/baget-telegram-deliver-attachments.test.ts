/**
 * Tests for deliver() handling of `OutboundMessage.attachments[]`.
 *
 * The MCP send-document tool (and any future code that wants to ship
 * artifacts to a founder) populates `message.attachments[]` and calls
 * deliver() through the standard channel API. This file pins the
 * end-to-end flow:
 *
 *   - photo + text → 1 sendPhoto, then 1 sendMessage with persona prefix
 *   - document only → 1 sendDocument, no sendMessage
 *   - photo + document + text → 3 calls in that order
 *   - persona prefix applies ONLY to text, NOT to attachments
 *   - per-attachment failure does NOT abort the loop
 *   - text-failure-after-attachments still returns last successful
 *     messageId
 *   - empty messages (no text, no attachments) drop with undefined
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

import { _testBuildBagetTelegramAdapter, BAGET_TELEGRAM_CHANNEL_TYPE } from './baget-telegram.js';
import { bindBagetTelegramChat } from './baget-telegram-bind.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createBagetAgentGroup } from '../db/baget-agent-groups.js';
import type { ChannelSetup, OutboundMessage } from './adapter.js';

const ADMIN_TOKEN = 'test-admin-token-1234567890abcdef';
const WEBHOOK_SECRET = 'test-webhook-secret-1234567890';
const AGENT_GROUP_ID = 'ag-deliver-attach-1';
const CHAT_ID = 555001;

interface CapturedSend {
  url: string;
  /** sendMessage POSTs JSON; sendPhoto/Document POSTs FormData. */
  bodyKind: 'json' | 'form';
  json?: { chat_id: string | number; text?: string };
  /** Form fields captured: chat_id, caption, plus the binary key (photo/document). */
  formFields?: Record<string, string>;
  /** Which Telegram method was hit — derived from URL. */
  method: 'sendMessage' | 'sendPhoto' | 'sendDocument' | 'other';
}

function nowIso(): string {
  return new Date().toISOString();
}

describe('deliver() — outbound attachments', () => {
  let outbound: CapturedSend[];
  let adapter: ReturnType<typeof _testBuildBagetTelegramAdapter> | null = null;
  let tmpDir: string;
  let photoPath: string;
  let documentPath: string;

  // Toggle to make sendPhoto/sendDocument fail with 500 in a particular
  // call — used by the per-attachment failure test.
  let failPhotoOnce: boolean;
  let failDocumentOnce: boolean;
  let failNextSendMessage: boolean;

  beforeEach(async () => {
    initTestDb();
    runMigrations(getDb());

    // Seed agent_group + paired chat (1:1 wiring required for
    // applyPersonaPrefix and to make agentGroupId resolvable in deliver).
    createBagetAgentGroup({
      id: AGENT_GROUP_ID,
      name: 'Deliver Test Co',
      folder: 'deliver-test',
      user_id: 'user-d',
      company_id: 'company-d',
      baget_team_members: JSON.stringify({ cos: 'Louis', developer: 'Valentin' }),
      created_at: nowIso(),
    });
    expect(bindBagetTelegramChat({ chatId: CHAT_ID, agentGroupId: AGENT_GROUP_ID, firstName: 'Sam' }).ok).toBe(true);

    // Real files on disk so the helpers' readFileSync calls succeed.
    tmpDir = join(tmpdir(), `deliver-attach-${randomBytes(4).toString('hex')}`);
    mkdirSync(tmpDir, { recursive: true });
    photoPath = join(tmpDir, 'logo.png');
    documentPath = join(tmpDir, 'pitch.pdf');
    writeFileSync(photoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])); // PNG header
    writeFileSync(documentPath, Buffer.from('%PDF-1.4\n%fake'));

    outbound = [];
    failPhotoOnce = false;
    failDocumentOnce = false;
    failNextSendMessage = false;

    adapter = _testBuildBagetTelegramAdapter({
      botToken: 'bot-token',
      webhookSecret: WEBHOOK_SECRET,
      adminToken: ADMIN_TOKEN,
      apiBaseUrl: 'https://api.telegram.test',
      inboundDebounceMs: 100,
      fetchImpl: async (url, init) => {
        const u = String(url);
        const method: CapturedSend['method'] = u.endsWith('/sendMessage')
          ? 'sendMessage'
          : u.endsWith('/sendPhoto')
            ? 'sendPhoto'
            : u.endsWith('/sendDocument')
              ? 'sendDocument'
              : 'other';

        const body = init?.body;
        if (body instanceof FormData) {
          const formFields: Record<string, string> = {};
          for (const [key, value] of body.entries()) {
            if (typeof value === 'string') formFields[key] = value;
            else formFields[key] = `<binary:${(value as Blob).size}b>`;
          }
          outbound.push({ url: u, bodyKind: 'form', formFields, method });
        } else {
          outbound.push({
            url: u,
            bodyKind: 'json',
            json: JSON.parse(String(body ?? '{}')) as { chat_id: string | number; text?: string },
            method,
          });
        }

        // Per-call failure toggles consume a single use.
        if (method === 'sendPhoto' && failPhotoOnce) {
          failPhotoOnce = false;
          return new Response(JSON.stringify({ ok: false, description: 'Internal' }), { status: 500 });
        }
        if (method === 'sendDocument' && failDocumentOnce) {
          failDocumentOnce = false;
          return new Response(JSON.stringify({ ok: false, description: 'Internal' }), { status: 500 });
        }
        if (method === 'sendMessage' && failNextSendMessage) {
          failNextSendMessage = false;
          return new Response(JSON.stringify({ ok: false, description: 'Internal' }), { status: 500 });
        }

        return new Response(
          JSON.stringify({ ok: true, result: { message_id: outbound.length } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const setup: ChannelSetup = {
      onInbound() {},
      onInboundEvent() {},
      onMetadata() {},
      onAction() {},
    };
    await adapter.setup(setup);
  });

  afterEach(async () => {
    await adapter?.teardown();
    closeDb();
    adapter = null;
  });

  it('photo + text — sends photo then persona-prefixed text', async () => {
    const messageId = await adapter!.deliver(`baget-telegram:${CHAT_ID}`, null, {
      kind: 'chat',
      content: { text: 'cos: Here is the logo we shipped today.' },
      attachments: [{ kind: 'photo', path: photoPath, caption: 'V3 logo' }],
    } satisfies OutboundMessage);

    expect(outbound).toHaveLength(2);
    expect(outbound[0]?.method).toBe('sendPhoto');
    expect(outbound[0]?.formFields?.chat_id).toBe(String(CHAT_ID));
    expect(outbound[0]?.formFields?.caption).toBe('V3 logo');
    expect(outbound[0]?.formFields?.photo).toMatch(/^<binary:/);
    expect(outbound[1]?.method).toBe('sendMessage');
    // Persona prefix lands on the text, NOT on the photo caption.
    expect(outbound[1]?.json?.text).toBe('🧭 Louis: Here is the logo we shipped today.');
    expect(messageId).toBe('2'); // last-sent
  });

  it('document only, no text — sends document, no sendMessage', async () => {
    const messageId = await adapter!.deliver(`baget-telegram:${CHAT_ID}`, null, {
      kind: 'chat',
      content: { text: '' },
      attachments: [{ kind: 'document', path: documentPath, filename: 'baget-pitch-v3.pdf' }],
    } satisfies OutboundMessage);

    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.method).toBe('sendDocument');
    expect(outbound[0]?.formFields?.chat_id).toBe(String(CHAT_ID));
    expect(outbound[0]?.formFields?.document).toMatch(/^<binary:/);
    expect(messageId).toBe('1');
  });

  it('photo + document + text — three calls in order', async () => {
    const messageId = await adapter!.deliver(`baget-telegram:${CHAT_ID}`, null, {
      kind: 'chat',
      content: { text: 'cos: Logo + deck attached.' },
      attachments: [
        { kind: 'photo', path: photoPath },
        { kind: 'document', path: documentPath, filename: 'deck.pdf' },
      ],
    } satisfies OutboundMessage);

    expect(outbound).toHaveLength(3);
    expect(outbound[0]?.method).toBe('sendPhoto');
    expect(outbound[1]?.method).toBe('sendDocument');
    expect(outbound[2]?.method).toBe('sendMessage');
    expect(outbound[2]?.json?.text).toBe('🧭 Louis: Logo + deck attached.');
    expect(messageId).toBe('3');
  });

  it('per-attachment failure does NOT abort: subsequent attachments + text still send', async () => {
    failPhotoOnce = true;

    const messageId = await adapter!.deliver(`baget-telegram:${CHAT_ID}`, null, {
      kind: 'chat',
      content: { text: 'cos: Logo + deck attached.' },
      attachments: [
        { kind: 'photo', path: photoPath },
        { kind: 'document', path: documentPath, filename: 'deck.pdf' },
      ],
    } satisfies OutboundMessage);

    // All 3 fetch calls fired even though photo failed.
    expect(outbound).toHaveLength(3);
    expect(outbound[0]?.method).toBe('sendPhoto'); // failed
    expect(outbound[1]?.method).toBe('sendDocument'); // succeeded — id 2
    expect(outbound[2]?.method).toBe('sendMessage'); // succeeded — id 3
    // messageId is the last successful send (sendMessage's id).
    expect(messageId).toBe('3');
  });

  it('text fails after attachments succeed: returns last successful attachment messageId', async () => {
    failNextSendMessage = true;

    const messageId = await adapter!.deliver(`baget-telegram:${CHAT_ID}`, null, {
      kind: 'chat',
      content: { text: 'cos: hello' },
      attachments: [{ kind: 'document', path: documentPath, filename: 'a.pdf' }],
    } satisfies OutboundMessage);

    expect(outbound).toHaveLength(2);
    expect(outbound[0]?.method).toBe('sendDocument'); // succeeded — id 1
    expect(outbound[1]?.method).toBe('sendMessage'); // failed
    // The doc landed; the text didn't. Last successful messageId is the
    // document's id 1.
    expect(messageId).toBe('1');
  });

  it('attachments without text — no persona prefix anywhere (artifacts have no voice)', async () => {
    await adapter!.deliver(`baget-telegram:${CHAT_ID}`, null, {
      kind: 'chat',
      content: { text: '' },
      attachments: [{ kind: 'photo', path: photoPath, caption: 'No prefix here' }],
    } satisfies OutboundMessage);

    expect(outbound).toHaveLength(1);
    // Caption stays exactly as-is — no `🧭 Louis:` injected anywhere.
    expect(outbound[0]?.formFields?.caption).toBe('No prefix here');
  });

  it('empty message (no text, no attachments) drops with undefined', async () => {
    const messageId = await adapter!.deliver(`baget-telegram:${CHAT_ID}`, null, {
      kind: 'chat',
      content: { text: '' },
    } satisfies OutboundMessage);

    expect(messageId).toBeUndefined();
    expect(outbound).toHaveLength(0);
  });
});
