import http from 'http';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock compute-scopes — needs a real DB; stub it out (post-build QA fix MF-3:
// requireAuth now uses computeScopes via dynamic import, replacing the prior
// canAccessAgentGroup approach that was leaving scoped admins with empty groups).
vi.mock('./auth/compute-scopes.js', () => ({
  computeScopes: vi.fn(() => ({
    role: 'owner' as const,
    allowed_group_ids: [],
    no_filter: true,
  })),
}));

import { pathMatch, register, requireAuth, dispatch, registerCookieVerifier, clearCookieVerifier } from './router.js';
import * as scopesMod from './auth/compute-scopes.js';

function makeNodeReq(overrides: Partial<http.IncomingMessage> = {}): http.IncomingMessage {
  return {
    headers: {},
    method: 'GET',
    url: '/',
    ...overrides,
  } as unknown as http.IncomingMessage;
}

function makeNodeRes(): http.ServerResponse {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as http.ServerResponse;
}

function makeWebRequest(url: string, options: RequestInit = {}): Request {
  return new Request(`http://localhost:3000${url}`, options);
}

beforeEach(() => {
  clearCookieVerifier();
  vi.mocked(scopesMod.computeScopes).mockReset();
  vi.mocked(scopesMod.computeScopes).mockReturnValue({
    role: 'owner',
    allowed_group_ids: [],
    no_filter: true,
  });
});

describe('pathMatch', () => {
  it('test_pathMatch_param', () => {
    const result = pathMatch('/dashboard/api/tasks/:id', '/dashboard/api/tasks/spawn-abc');
    expect(result).toEqual({ id: 'spawn-abc' });
  });

  it('test_pathMatch_splat', () => {
    const result = pathMatch('/dashboard/static/*tail', '/dashboard/static/assets/foo/bar.js');
    expect(result).toEqual({ tail: 'assets/foo/bar.js' });
  });

  it('test_pathMatch_no_match', () => {
    const result = pathMatch('/dashboard/api/tasks/:id', '/dashboard/api/sessions');
    expect(result).toBeNull();
  });

  it('test_pathMatch_splat_empty_tail', () => {
    const result = pathMatch('/dashboard/static/*tail', '/dashboard/static/');
    expect(result).toEqual({ tail: '' });
  });
});

describe('requireAuth and dispatch', () => {
  it('test_requireAuth_no_cookie_returns_401', async () => {
    // No verifier registered → null → 401
    const handler = vi.fn().mockResolvedValue(new Response('ok'));
    register('GET', '/test-401', requireAuth(handler));

    const req = makeWebRequest('/test-401');
    const nodeReq = makeNodeReq({ headers: {}, method: 'GET', url: '/test-401' });
    const nodeRes = makeNodeRes();

    const result = await dispatch(req, nodeReq, nodeRes);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    const body = (await result!.json()) as { error: string };
    expect(body.error).toBe('unauthenticated');
    expect(handler).not.toHaveBeenCalled();
  });

  it('test_requireAuth_origin_mismatch_returns_403', async () => {
    registerCookieVerifier(() => ({ user_id: 'u1', expires_at: '2099-01-01T00:00:00Z' }));
    // computeScopes mock already returns owner+no_filter via beforeEach default

    const handler = vi.fn().mockResolvedValue(new Response('ok'));
    register('POST', '/test-403', requireAuth(handler));

    const req = makeWebRequest('/test-403', {
      method: 'POST',
      headers: {
        origin: 'https://evil.com',
        host: 'localhost:3000',
        cookie: 'spawn_board=sometoken',
      },
    });
    const nodeReq = makeNodeReq({
      headers: { origin: 'https://evil.com', host: 'localhost:3000', cookie: 'spawn_board=sometoken' },
      method: 'POST',
      url: '/test-403',
    });
    const nodeRes = makeNodeRes();

    const result = await dispatch(req, nodeReq, nodeRes);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = (await result!.json()) as { error: string };
    expect(body.error).toBe('origin_mismatch');
    expect(handler).not.toHaveBeenCalled();
  });

  it('test_requireAuth_localhost_origin_accepted', async () => {
    registerCookieVerifier(() => ({ user_id: 'u1', expires_at: '2099-01-01T00:00:00Z' }));
    // computeScopes mock already returns owner+no_filter via beforeEach default

    const handler = vi.fn().mockResolvedValue(new Response('handler ran', { status: 200 }));
    register('POST', '/test-localhost', requireAuth(handler));

    const req = makeWebRequest('/test-localhost', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
        cookie: 'spawn_board=sometoken',
      },
    });
    const nodeReq = makeNodeReq({
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000', cookie: 'spawn_board=sometoken' },
      method: 'POST',
      url: '/test-localhost',
    });
    const nodeRes = makeNodeRes();

    const result = await dispatch(req, nodeReq, nodeRes);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('test_dispatch_null_return_skips_fromWebResponse', async () => {
    const nodeRes = makeNodeRes();
    let rawNodeResWritten = false;

    const handler = vi
      .fn()
      .mockImplementation(
        async (_req: Request, _params: Record<string, string>, ctx: { rawNodeRes?: http.ServerResponse }) => {
          ctx.rawNodeRes?.write('data: keep-alive\n\n');
          rawNodeResWritten = true;
          return null;
        },
      );

    register('GET', '/test-null', handler);

    const req = makeWebRequest('/test-null');
    const nodeReq = makeNodeReq({ method: 'GET', url: '/test-null' });

    const result = await dispatch(req, nodeReq, nodeRes);
    expect(result).toBeNull();
    expect(rawNodeResWritten).toBe(true);
    expect(nodeRes.end).not.toHaveBeenCalled();
  });
});
