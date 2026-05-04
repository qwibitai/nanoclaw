/**
 * Tests for the baget MCP tools — focused on the document-handling
 * surface. The earlier hallucination of `baget_send_document_file`
 * (the model invented a tool that didn't exist) is now closed by
 * shipping a REAL `baget_send_document_file` tool plus the
 * `baget_read_document` tool that does inline quoting. The two-tool
 * split has to stay legible to the model — the description tests
 * below guard against silent regression of the discovery surface.
 *
 * Mocking strategy:
 *   - `globalThis.fetch` — intercepted in beforeEach and dispatched
 *     by URL substring so the multi-hop send_document_file flow
 *     (POST /render-pdf → GET blob) can return distinct payloads.
 *   - SQLite — `initTestSessionDb` spins an in-memory DB pair so
 *     `writeMessageOut` works without a real workspace mount.
 *   - Filesystem — `BAGET_WORKSPACE` points at a tmpdir so outbox
 *     writes land somewhere we can inspect and clean up.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import './baget.js'; // registers the tools as a side effect
import { getRegisteredToolByName } from './server.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TOKEN = process.env.BAGET_CHANNEL_TOKEN;
const ORIGINAL_COMPANY = process.env.BAGET_COMPANY_ID;
const ORIGINAL_BASE = process.env.BAGET_API_BASE_URL;
const ORIGINAL_WORKSPACE = process.env.BAGET_WORKSPACE;

interface FetchCall {
  url: string;
  method?: string;
  authHeader?: string | null;
}

/**
 * URL-keyed fetch dispatcher. Tests register response factories per URL
 * substring so the multi-hop send_document_file flow (one POST to
 * baget.ai's /render-pdf, one GET to a Vercel Blob URL) can return
 * distinct payloads without bespoke wiring per test.
 *
 * `defaultResponse` is what unrecognized URLs return — keep it a benign
 * 200 with an empty JSON body so a stray fetch doesn't cascade into a
 * confusing JSON-parse error and obscure the real assertion failure.
 */
let fetchCalls: FetchCall[] = [];
let routedResponses: Array<{ matches: (url: string) => boolean; respond: () => Response }> = [];
let defaultResponse: () => Response = () => new Response('{}', { status: 200 });

function setDefaultResponse(fn: () => Response): void {
  defaultResponse = fn;
}

function routeResponse(matches: (url: string) => boolean, respond: () => Response): void {
  routedResponses.push({ matches, respond });
}

function installFetchSpy(): void {
  fetchCalls = [];
  routedResponses = [];
  defaultResponse = () => new Response('{}', { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({
      url,
      method: init?.method,
      authHeader: headers['Authorization'] ?? headers['authorization'] ?? null,
    });
    for (const route of routedResponses) {
      if (route.matches(url)) return route.respond();
    }
    return defaultResponse();
  }) as typeof fetch;
}

const tmpWorkspaces: string[] = [];

function setupWorkspace(): string {
  // The runner creates `<workspace>/outbox/<msgId>/` on demand via
  // recursive mkdir, so we only need a writable root here. Path layout
  // tracks `workspaceOutboxDir()` in workspace-paths.ts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baget-mcp-test-'));
  tmpWorkspaces.push(dir);
  process.env.BAGET_WORKSPACE = dir;
  return dir;
}

beforeEach(() => {
  process.env.BAGET_CHANNEL_TOKEN = 'test-bearer-token';
  process.env.BAGET_COMPANY_ID = 'company-uuid-123';
  process.env.BAGET_API_BASE_URL = 'https://stg-app.baget.ai';
  installFetchSpy();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_TOKEN === undefined) delete process.env.BAGET_CHANNEL_TOKEN;
  else process.env.BAGET_CHANNEL_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_COMPANY === undefined) delete process.env.BAGET_COMPANY_ID;
  else process.env.BAGET_COMPANY_ID = ORIGINAL_COMPANY;
  if (ORIGINAL_BASE === undefined) delete process.env.BAGET_API_BASE_URL;
  else process.env.BAGET_API_BASE_URL = ORIGINAL_BASE;
  if (ORIGINAL_WORKSPACE === undefined) delete process.env.BAGET_WORKSPACE;
  else process.env.BAGET_WORKSPACE = ORIGINAL_WORKSPACE;

  // Cleanup any test DBs and tmpdirs.
  try {
    closeSessionDb();
  } catch {
    // Some tests don't open a DB — the close is a no-op.
  }
  for (const dir of tmpWorkspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('baget_read_document tool registration', () => {
  it('is registered under the exact name the prompt references', () => {
    const tool = getRegisteredToolByName('baget_read_document');
    expect(tool).toBeDefined();
    expect(tool!.tool.name).toBe('baget_read_document');
  });

  it('description steers the model toward inline-quoting use cases and disambiguates from send_document_file', () => {
    // The two-tool split (read_document = inline quote, send_document_file
    // = real attachment) only works if the model can pick correctly from
    // the descriptions. read_document MUST highlight discuss/summarize/
    // quote semantics AND name send_document_file as the alternative —
    // otherwise the model will reach for read_document when the founder
    // wants the actual file (regression of the original hallucination).
    const tool = getRegisteredToolByName('baget_read_document');
    const description = tool!.tool.description ?? '';
    expect(description.toLowerCase()).toContain('quote');
    expect(description.toLowerCase()).toContain('summarize');
    expect(description.toLowerCase()).toContain('inline');
    expect(description).toContain('baget_send_document_file');
    expect(description).toContain('baget_list_documents');
  });

  it('declares documentId as a required uuid string', () => {
    const tool = getRegisteredToolByName('baget_read_document');
    const schema = tool!.tool.inputSchema as {
      properties: Record<string, { type: string; format?: string }>;
      required?: string[];
    };
    expect(schema.required).toEqual(['documentId']);
    expect(schema.properties.documentId?.type).toBe('string');
    expect(schema.properties.documentId?.format).toBe('uuid');
  });
});

describe('baget_list_documents description', () => {
  it('points the model at BOTH baget_read_document and baget_send_document_file as next steps', () => {
    // The list endpoint is the entry point — its description has to seed
    // the discovery surface for both follow-up tools, otherwise the model
    // either invents a tool name (the original hallucination) or gets
    // stuck on whichever tool happens to come first in the registered list.
    const tool = getRegisteredToolByName('baget_list_documents');
    const description = tool!.tool.description ?? '';
    expect(description).toContain('baget_read_document');
    expect(description).toContain('baget_send_document_file');
  });
});

describe('baget_read_document handler', () => {
  it('GETs the per-document endpoint with bearer auth and returns the unwrapped document body', async () => {
    // Production response shape from baget.ai's GET /api/companies/:id/documents/:docId
    // is `{ document: { id, title, content, category, agentRole, agentName, cycle, createdAt } }`
    // — wrapped under `document`. The handler unwraps so the model gets just the
    // document object (Gemini medium on PR #12 — saves tokens in the agent's context).
    const docPayload = {
      document: {
        id: 'doc-uuid-456',
        title: 'Pitch Deck',
        category: 'pitch-deck',
        content: '# Vela\n\nFashion designer marketplace.\n\n## Problem\n\n…',
      },
    };
    setDefaultResponse(() => new Response(JSON.stringify(docPayload), { status: 200 }));

    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://stg-app.baget.ai/api/companies/company-uuid-123/documents/doc-uuid-456');
    expect(fetchCalls[0].method).toBe('GET');
    expect(fetchCalls[0].authHeader).toBe('Bearer test-bearer-token');
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    // Body of the document is included...
    expect(text).toContain('Vela');
    expect(text).toContain('Fashion designer marketplace');
    expect(text).toContain('doc-uuid-456');
    // ...but the `document` envelope key is NOT — that's the unwrap working.
    const parsed = JSON.parse(text);
    expect(parsed).not.toHaveProperty('document');
    expect(parsed.id).toBe('doc-uuid-456');
    expect(parsed.title).toBe('Pitch Deck');
  });

  it('falls back to the raw payload when the upstream shape lacks a `document` key', async () => {
    // Defensive — if baget.ai ever changes the response shape we'd
    // rather surface the unfamiliar JSON than null it out.
    const flatPayload = { id: 'doc-uuid-789', title: 'Old Shape', content: 'Body.' };
    fetchResponse = () => new Response(JSON.stringify(flatPayload), { status: 200 });
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-789' });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Old Shape');
    expect(text).toContain('doc-uuid-789');
  });

  it('URL-encodes the documentId so a hallucinated path traversal is neutralized', async () => {
    setDefaultResponse(() => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
    const tool = getRegisteredToolByName('baget_read_document');
    await tool!.handler({ documentId: '../other-tenant/secret' });
    expect(fetchCalls).toHaveLength(1);
    // `..` and `/` must be percent-encoded — never let them re-target the URL.
    expect(fetchCalls[0].url).not.toContain('/other-tenant/');
    expect(fetchCalls[0].url).toContain('%2F');
  });

  it('returns a structured error when documentId is missing', async () => {
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('documentId');
    expect(fetchCalls).toHaveLength(0);
  });

  it('returns a structured error when documentId is an empty string', async () => {
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: '   ' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('documentId');
    expect(fetchCalls).toHaveLength(0);
  });

  it('surfaces upstream errors instead of swallowing them', async () => {
    setDefaultResponse(() => new Response(JSON.stringify({ error: 'document not found' }), { status: 404 }));
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-missing' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('read_document failed');
    expect(text).toContain('document not found');
  });

  it('errors clearly when the channel token is missing', async () => {
    delete process.env.BAGET_CHANNEL_TOKEN;
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('BAGET_CHANNEL_TOKEN');
    expect(fetchCalls).toHaveLength(0);
  });

  it('errors clearly when the company id is missing', async () => {
    delete process.env.BAGET_COMPANY_ID;
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('BAGET_COMPANY_ID');
    expect(fetchCalls).toHaveLength(0);
  });
});

// ── send_document_file ──────────────────────────────────────────────────────

const PDF_HEADER = Buffer.from('%PDF-1.4\n%test pdf bytes\n');
// Real Vercel Blob URLs look like
// `https://<store-id>.public.blob.vercel-storage.com/<path>` — the
// `.public.blob.vercel-storage.com` suffix is the SSRF allowlist anchor
// in baget.ts. Tests must use this exact suffix or the host check rejects.
const BLOB_URL =
  'https://test-store-abc.public.blob.vercel-storage.com/attachments/company-uuid-123/pitch-deck-1234567890.pdf';

/**
 * Wires up the test session DB (in-memory SQLite pair) and seeds a single
 * destination so `resolveRouting(undefined)` falls through to it. Returns
 * the destination tuple so tests can assert on it.
 *
 * The session_routing table isn't part of `initTestSessionDb`'s schema —
 * `getSessionRouting` swallows the missing-table error and returns nulls,
 * which triggers the destination-fallback branch in `resolveRouting`.
 * Seeding ONE destination is the smallest config that exercises the
 * production code path without ambiguity errors.
 */
function seedSingleDestination(): { channel_type: string; platform_id: string } {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('founder', 'Founder Telegram', 'channel', 'telegram', 'tg-chat-42', NULL)`,
    )
    .run();
  return { channel_type: 'telegram', platform_id: 'tg-chat-42' };
}

describe('baget_send_document_file tool registration', () => {
  it('is registered under the name the prompt now points at', () => {
    const tool = getRegisteredToolByName('baget_send_document_file');
    expect(tool).toBeDefined();
    expect(tool!.tool.name).toBe('baget_send_document_file');
  });

  it('description tells the model when to pick THIS over read_document — no regression of the original hallucination', () => {
    // The original bug was the model hallucinating this tool name when it
    // didn't exist. Now it exists; the failure mode shifts to the model
    // picking the WRONG document tool. The description has to lead with
    // the file-attachment intent so the founder's "send me the deck"
    // → this tool, not read_document.
    const tool = getRegisteredToolByName('baget_send_document_file');
    const description = tool!.tool.description ?? '';
    expect(description.toLowerCase()).toContain('file attachment');
    expect(description.toLowerCase()).toContain('send me the deck');
    expect(description).toContain('baget_read_document');
    expect(description).toContain('baget_list_documents');
  });

  it('declares documentId as required uuid plus an optional caption text', () => {
    const tool = getRegisteredToolByName('baget_send_document_file');
    const schema = tool!.tool.inputSchema as {
      properties: Record<string, { type: string; format?: string; maxLength?: number }>;
      required?: string[];
    };
    expect(schema.required).toEqual(['documentId']);
    expect(schema.properties.documentId?.type).toBe('string');
    expect(schema.properties.documentId?.format).toBe('uuid');
    expect(schema.properties.text?.type).toBe('string');
    expect(typeof schema.properties.text?.maxLength).toBe('number');
  });
});

describe('baget_send_document_file handler — success path', () => {
  it('POSTs render-pdf, fetches the blob, writes the file to outbox, and enqueues a messages_out row', async () => {
    seedSingleDestination();
    const workspace = setupWorkspace();

    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(
          JSON.stringify({
            blobUrl: BLOB_URL,
            blobKey: 'attachments/company-uuid-123/pitch-deck-1234567890.pdf',
            filename: 'pitch-deck.pdf',
            mimeType: 'application/pdf',
          }),
          { status: 200 },
        ),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response(PDF_HEADER, { status: 200 }),
    );

    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain('pitch-deck.pdf');

    // Two fetches: one POST to baget.ai with bearer, one GET to the blob (no auth needed).
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].url).toBe(
      'https://stg-app.baget.ai/api/companies/company-uuid-123/documents/doc-uuid-456/render-pdf',
    );
    expect(fetchCalls[0].method).toBe('POST');
    expect(fetchCalls[0].authHeader).toBe('Bearer test-bearer-token');
    expect(fetchCalls[1].url).toBe(BLOB_URL);

    // File staged on disk under the per-message outbox dir
    // (`<workspace>/outbox/<msgId>/<filename>` per workspace-paths.ts).
    const outboxRoot = path.join(workspace, 'outbox');
    const messageDirs = fs.readdirSync(outboxRoot);
    expect(messageDirs).toHaveLength(1);
    const stagedFile = path.join(outboxRoot, messageDirs[0], 'pitch-deck.pdf');
    expect(fs.existsSync(stagedFile)).toBe(true);
    expect(fs.readFileSync(stagedFile).equals(PDF_HEADER)).toBe(true);

    // messages_out row written with the destination routing + filename pointer.
    const rows = getOutboundDb().prepare('SELECT platform_id, channel_type, content FROM messages_out').all() as Array<{
      platform_id: string;
      channel_type: string;
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].platform_id).toBe('tg-chat-42');
    expect(rows[0].channel_type).toBe('telegram');
    // Path-based attachments contract (PR #18 / OutboundAttachment) — the
    // ONLY contract the Telegram adapter's deliver() loop reads. Asserting
    // on this shape locks in the wire so a future regression to the
    // legacy `content.files` shape (which silently drops on Telegram)
    // surfaces here instead of in production.
    const content = JSON.parse(rows[0].content);
    expect(content.text).toBe('');
    expect(content.files).toBeUndefined();
    expect(content.attachments).toHaveLength(1);
    expect(content.attachments[0]).toMatchObject({
      kind: 'document',
      filename: 'pitch-deck.pdf',
    });
    // The path is absolute and points at the staged outbox file the
    // host process can read directly.
    expect(content.attachments[0].path).toBe(stagedFile);
  });

  it('rides the optional caption text WITH the attachment (not as a separate sendMessage)', async () => {
    // Telegram's sendDocument supports up to 1024 chars of caption that
    // renders as a single bubble with the file. Splitting into a
    // separate text bubble would make the founder see two messages
    // for one user-facing intent. Caption stays on the attachment;
    // outer `text` stays empty.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'bp.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response(PDF_HEADER, { status: 200 }),
    );

    const tool = getRegisteredToolByName('baget_send_document_file');
    await tool!.handler({
      documentId: 'doc-uuid-456',
      text: "Here's the BP — section 3 covers the moat.",
    });

    const rows = getOutboundDb().prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
    const content = JSON.parse(rows[0].content);
    expect(content.text).toBe('');
    expect(content.attachments[0].caption).toBe("Here's the BP — section 3 covers the moat.");
  });

  it('omits caption when text arg is missing or whitespace-only', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'bp.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response(PDF_HEADER, { status: 200 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    await tool!.handler({ documentId: 'doc-uuid-456', text: '   ' });
    const rows = getOutboundDb().prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
    const content = JSON.parse(rows[0].content);
    expect(content.attachments[0].caption).toBeUndefined();
  });

  it('URL-encodes the documentId so a hallucinated path traversal is neutralized', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    await tool!.handler({ documentId: '../other-tenant/secret' });
    expect(fetchCalls[0].url).not.toContain('/other-tenant/');
    expect(fetchCalls[0].url).toContain('%2F');
  });
});

describe('baget_send_document_file handler — failure paths', () => {
  it('returns an error when documentId is missing', async () => {
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('documentId');
    expect(fetchCalls).toHaveLength(0);
  });

  it('surfaces upstream render-pdf errors instead of swallowing them', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () => new Response(JSON.stringify({ error: 'Document has no content' }), { status: 422 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-empty' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('send_document_file failed');
    expect(text).toContain('Document has no content');
    // Should NOT have attempted the blob fetch after render-pdf failed.
    expect(fetchCalls).toHaveLength(1);
  });

  it('errors when render-pdf returns a malformed response (no blobUrl)', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () => new Response(JSON.stringify({ filename: 'pitch.pdf' }), { status: 200 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('unexpected response');
    expect(fetchCalls).toHaveLength(1);
  });

  it('errors when the blob fetch fails (HTTP 500)', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () => new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'x.pdf' }), { status: 200 }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response('upstream blob storage error', { status: 500 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('500');
    // Render-pdf and blob fetch happened; nothing should be written to outbox/DB.
    expect(fetchCalls).toHaveLength(2);
  });

  it('errors when the bearer token is missing — no fetch attempted', async () => {
    delete process.env.BAGET_CHANNEL_TOKEN;
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('BAGET_CHANNEL_TOKEN');
    expect(fetchCalls).toHaveLength(0);
  });

  it('errors when the company id is missing — no fetch attempted', async () => {
    delete process.env.BAGET_COMPANY_ID;
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('BAGET_COMPANY_ID');
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('baget_send_document_file handler — SSRF + filename hardening', () => {
  it('refuses to fetch a blobUrl outside the Vercel Blob domain (SSRF defense)', async () => {
    // If baget.ai were compromised, a malicious response could direct
    // the agent to fetch internal services (instance metadata, internal
    // RPC endpoints, etc.). Locking the destination host closes that
    // class entirely. The fetch must NEVER happen for a disallowed host.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(
          JSON.stringify({
            blobUrl: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
            filename: 'pwned.pdf',
            mimeType: 'application/pdf',
          }),
          { status: 200 },
        ),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('outside the allowed Vercel Blob domain');
    // Only the render-pdf POST should have fired; the agent must NOT
    // have attempted to reach the metadata IP.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls.some((c) => c.url.includes('169.254.169.254'))).toBe(false);
  });

  it('refuses an http (non-https) blobUrl even on the allowed host', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(
          JSON.stringify({
            blobUrl: 'http://test-store-abc.public.blob.vercel-storage.com/x.pdf',
            filename: 'x.pdf',
            mimeType: 'application/pdf',
          }),
          { status: 200 },
        ),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('outside the allowed Vercel Blob domain');
    expect(fetchCalls).toHaveLength(1);
  });

  it('refuses a malformed blobUrl', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: 'not a url', filename: 'x.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('invalid blobUrl');
    expect(fetchCalls).toHaveLength(1);
  });

  it('strips path separators from the server-supplied filename (defense-in-depth)', async () => {
    // path.basename collapses `../../../etc/passwd` to `passwd`. Even if
    // the server's slugifier ever leaked separators, the file lands
    // inside the per-message outbox dir, not somewhere on the host fs.
    seedSingleDestination();
    const workspace = setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(
          JSON.stringify({
            blobUrl: BLOB_URL,
            filename: '../../../etc/passwd',
            mimeType: 'application/pdf',
          }),
          { status: 200 },
        ),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response(PDF_HEADER, { status: 200 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBeUndefined();
    // File must land under outbox/<msgId>/ — not at /etc/passwd.
    const outboxRoot = path.join(workspace, 'outbox');
    const messageDirs = fs.readdirSync(outboxRoot);
    expect(messageDirs).toHaveLength(1);
    expect(fs.existsSync(path.join(outboxRoot, messageDirs[0], 'passwd'))).toBe(true);
    // Sanity — nothing escaped the workspace.
    expect(fs.existsSync(path.join(workspace, '..', '..', '..', 'etc', 'passwd'))).toBe(false);
  });

  it('rejects a filename that path.basename collapses to empty / dot', async () => {
    // path.basename("/") === "" and path.basename("./") === "" — we
    // must reject before fs.writeFileSync attempts to write to the dir.
    for (const filename of ['/', './', '.', '..']) {
      seedSingleDestination();
      setupWorkspace();
      installFetchSpy(); // reset between iterations
      routeResponse(
        (url) => url.includes('/render-pdf'),
        () =>
          new Response(JSON.stringify({ blobUrl: BLOB_URL, filename, mimeType: 'application/pdf' }), { status: 200 }),
      );
      routeResponse(
        (url) => url === BLOB_URL,
        () => new Response(PDF_HEADER, { status: 200 }),
      );
      const tool = getRegisteredToolByName('baget_send_document_file');
      const result = await tool!.handler({ documentId: 'doc-uuid-456' });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('unusable filename');
      closeSessionDb();
    }
  });

  it('rejects on Content-Length pre-check WITHOUT buffering (OOM defense)', async () => {
    // Codex P1 + Gemini security-medium on PR #13: arrayBuffer() would
    // allocate the entire body BEFORE our size check, so a malicious
    // multi-GB response could OOM the runner. The new code checks
    // Content-Length first and rejects immediately if oversized — no
    // bytes ever land in process memory.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'huge.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      // Tiny body, but advertise a giant Content-Length — the
      // pre-check should reject without ever reading the body.
      () =>
        new Response('x', {
          status: 200,
          headers: { 'content-length': String(100 * 1024 * 1024) }, // 100 MB declared
        }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('100.0 MB');
    expect(text).toContain('chat-attachment limit');
    expect(fetchCalls).toHaveLength(2);
    const rows = getOutboundDb().prepare('SELECT id FROM messages_out').all();
    expect(rows).toHaveLength(0);
  });

  it('rejects mid-stream when Content-Length is missing and the body grows past the cap', async () => {
    // Defense for the case where the upstream omits Content-Length OR
    // lies (advertised < cap, actual >> cap). The streaming reader
    // accumulates bytes with a running total and aborts the moment
    // total > cap. Without this, an attacker could bypass the
    // Content-Length pre-check entirely.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'huge.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => {
        // Build a streamed body with NO Content-Length header that
        // emits 5 chunks of 10 MB each = 50 MB > 45 MB cap.
        const chunkSize = 10 * 1024 * 1024;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < 5; i++) {
              controller.enqueue(new Uint8Array(chunkSize));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('over the');
    expect(text).toContain('chat-attachment limit');
    expect(fetchCalls).toHaveLength(2);
    const rows = getOutboundDb().prepare('SELECT id FROM messages_out').all();
    expect(rows).toHaveLength(0);
  });

  it('rejects a Buffer-shaped Response over the cap via Content-Length pre-check', async () => {
    // Sanity: a real response body (Buffer-backed) sets Content-Length
    // automatically, so the pre-check fires the same way as the
    // declared-but-lying case above. Belt-and-braces over the OOM
    // defense — and the most realistic shape of a too-large blob.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'huge.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response(Buffer.alloc(46 * 1024 * 1024), { status: 200 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('chat-attachment limit');
    expect(fetchCalls).toHaveLength(2);
    const rows = getOutboundDb().prepare('SELECT id FROM messages_out').all();
    expect(rows).toHaveLength(0);
  });

  it('errors when /render-pdf returns an empty / non-JSON body (null-data guard)', async () => {
    // Gemini medium on PR #13: bagetFetch returns data: null on an
    // empty body or invalid JSON, even when ok: true. Without the
    // null check, the destructure throws an uncaught TypeError and
    // crashes the runner.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      // Empty body is valid HTTP but bagetFetch's JSON.parse fails →
      // result.data === null. This is the bug the test guards against.
      () => new Response('', { status: 200 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('empty or non-JSON');
    expect(fetchCalls).toHaveLength(1);
  });
});
