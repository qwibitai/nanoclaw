/**
 * Tests for google-auth MCP tools. The tools issue HTTPS GETs to
 * googleapis.com endpoints with no Authorization header, relying on the
 * OneCLI proxy to inject credentials. The test mocks the fetch seam.
 */
import { describe, it, expect, afterEach } from 'bun:test';

import { __setFetchForTesting, checkGoogleAuth, listGoogleScopes, TOKENINFO_URL, USERINFO_URL } from './google-auth.js';

interface MockResponse {
  ok: boolean;
  status: number;
  bodyText: string;
}

function jsonResponse(status: number, body: unknown): MockResponse {
  return { ok: status >= 200 && status < 300, status, bodyText: JSON.stringify(body) };
}

function mockFetch(routes: Record<string, MockResponse | (() => MockResponse)>) {
  return async (input: string): Promise<Response> => {
    // Match by URL prefix so query strings on the tokeninfo URL don't matter.
    const route = Object.keys(routes).find((k) => input.startsWith(k));
    if (!route) throw new Error(`Unexpected fetch URL: ${input}`);
    const entry = routes[route];
    const r = typeof entry === 'function' ? entry() : entry;
    return {
      ok: r.ok,
      status: r.status,
      text: async () => r.bodyText,
      json: async () => JSON.parse(r.bodyText),
    } as unknown as Response;
  };
}

afterEach(() => {
  __setFetchForTesting(null);
});

describe('check_google_auth', () => {
  it('returns OK with the connected account email on 200', async () => {
    __setFetchForTesting(
      mockFetch({
        [USERINFO_URL]: jsonResponse(200, { email: 'agent@example.com', sub: '12345' }),
      }),
    );

    const result = await checkGoogleAuth.handler({});
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Google auth OK');
    expect(text).toContain('agent@example.com');
  });

  it('returns an error with status + connect hint when OneCLI is not injecting a credential (401)', async () => {
    __setFetchForTesting(
      mockFetch({
        [USERINFO_URL]: { ok: false, status: 401, bodyText: '{"error":"unauthorized"}' },
      }),
    );

    const result = await checkGoogleAuth.handler({});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('401');
    expect(text).toContain('OneCLI gateway has no Google credential');
    expect(text).toContain('127.0.0.1:10254');
  });

  it('surfaces fetch exceptions as errors', async () => {
    __setFetchForTesting(async () => {
      throw new Error('proxy unreachable');
    });

    const result = await checkGoogleAuth.handler({});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('proxy unreachable');
  });
});

describe('list_google_scopes', () => {
  it('returns the granted scopes on a 200 tokeninfo response', async () => {
    __setFetchForTesting(
      mockFetch({
        [TOKENINFO_URL]: jsonResponse(200, {
          scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events',
          expires_in: 3599,
        }),
      }),
    );

    const result = await listGoogleScopes.handler({});
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('gmail.readonly');
    expect(text).toContain('calendar.events');
    expect(text).toContain('3599s');
  });

  it('reports a clear error when the OneCLI gateway does not rewrite the placeholder token (400)', async () => {
    __setFetchForTesting(
      mockFetch({
        [TOKENINFO_URL]: { ok: false, status: 400, bodyText: '{"error":"invalid_token"}' },
      }),
    );

    const result = await listGoogleScopes.handler({});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('400');
    expect(text).toContain('not rewriting the access_token');
  });
});
