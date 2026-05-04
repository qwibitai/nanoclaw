/**
 * Tests for the baget MCP tools — focused on the read-document path
 * because that's the surface that's been hallucinated as
 * `baget_send_document_file` in production. We exercise the registered
 * handler directly via getRegisteredToolByName so we test the actual
 * agent surface rather than re-implementing the wire protocol.
 *
 * Mocking strategy: monkey-patch globalThis.fetch in beforeEach and
 * restore in afterEach. The tools call the global fetch directly via
 * bagetFetch, so this is the right intercept point.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import './baget.js'; // registers the tools as a side effect
import { getRegisteredToolByName } from './server.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TOKEN = process.env.BAGET_CHANNEL_TOKEN;
const ORIGINAL_COMPANY = process.env.BAGET_COMPANY_ID;
const ORIGINAL_BASE = process.env.BAGET_API_BASE_URL;

interface FetchCall {
  url: string;
  method?: string;
  authHeader?: string | null;
}

let fetchCalls: FetchCall[] = [];
let fetchResponse: () => Response = () => new Response('{}', { status: 200 });

function installFetchSpy(): void {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({
      url,
      method: init?.method,
      authHeader: headers['Authorization'] ?? headers['authorization'] ?? null,
    });
    return fetchResponse();
  }) as typeof fetch;
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
  fetchResponse = () => new Response('{}', { status: 200 });
});

describe('baget_read_document tool registration', () => {
  it('is registered under the exact name the prompt references', () => {
    const tool = getRegisteredToolByName('baget_read_document');
    expect(tool).toBeDefined();
    expect(tool!.tool.name).toBe('baget_read_document');
  });

  it('description steers the model toward the share/send/read use case', () => {
    const tool = getRegisteredToolByName('baget_read_document');
    const description = tool!.tool.description ?? '';
    // The model needs to recognize this as the answer when the founder
    // asks to share/send/read a document. If these keywords drift the
    // hallucination-of-baget_send_document_file regression returns.
    expect(description.toLowerCase()).toContain('share');
    expect(description.toLowerCase()).toContain('send');
    expect(description.toLowerCase()).toContain('read');
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
  it('points the model at baget_read_document as the next step', () => {
    // Without this hint the model is more likely to invent a tool name
    // (the bug we are fixing). Asserting on the description keeps the
    // discoverability contract from drifting.
    const tool = getRegisteredToolByName('baget_list_documents');
    expect(tool!.tool.description).toContain('baget_read_document');
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
    fetchResponse = () => new Response(JSON.stringify(docPayload), { status: 200 });

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
    fetchResponse = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
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
    fetchResponse = () => new Response(JSON.stringify({ error: 'document not found' }), { status: 404 });
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
