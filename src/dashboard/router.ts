/**
 * Minimal route table for the dashboard HTTP server.
 *
 * First-match dispatch. Supports :param segments and terminal *tail splat.
 * requireAuth HOF verifies the spawn_board cookie via a registered verifier
 * (injected by Group B B5 at startup) and enforces CSRF origin check on
 * mutating methods.
 */
import http from 'http';

import type { User } from '../types.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type Handler = (req: Request, params: Record<string, string>, ctx: RequestContext) => Promise<Response | null>;
export type AuthHandler = (
  req: Request,
  params: Record<string, string>,
  ctx: AuthedRequestContext,
) => Promise<Response | null>;

export interface RequestContext {
  rawNodeReq: http.IncomingMessage;
  rawNodeRes?: http.ServerResponse;
}

export interface GroupScope {
  agent_group_id: string;
  role: 'owner' | 'global_admin' | 'admin_of_group' | 'member';
}

export interface AuthedRequestContext extends RequestContext {
  user: User;
  scopes: { role: GroupScope['role']; allowed_group_ids: string[]; no_filter: boolean };
}

// Dependency injection: B5 registers the real verifier via registerCookieVerifier().
// Returns { user_id, expires_at } on success or null on invalid/missing cookie.
export type CookieVerifier = (cookieHeader: string | null) => { user_id: string; expires_at: string } | null;

let cookieVerifier: CookieVerifier | null = null;

export function registerCookieVerifier(fn: CookieVerifier): void {
  cookieVerifier = fn;
}

export function getCookieVerifier(): CookieVerifier | null {
  return cookieVerifier;
}

export function clearCookieVerifier(): void {
  cookieVerifier = null;
}

export interface Route {
  method: Method;
  pattern: string;
  handler: Handler;
}

const routes: Route[] = [];

export function register(method: Method, pattern: string, handler: Handler): void {
  routes.push({ method, pattern, handler });
}

/** Expose the route table for testing (read-only snapshot). */
export function getRoutes(): ReadonlyArray<Readonly<Route>> {
  return routes;
}

/**
 * Match a URL path against a pattern.
 * :name captures a single segment; *tail is terminal and captures the rest.
 * Returns null on mismatch.
 */
export function pathMatch(pattern: string, urlPath: string): Record<string, string> | null {
  const patternSegments = pattern.split('/');
  const urlSegments = urlPath.split('/');

  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i++) {
    const ps = patternSegments[i];

    if (ps !== undefined && ps.startsWith('*')) {
      // Terminal splat — captures remaining segments joined with /
      const name = ps.slice(1);
      params[name] = urlSegments.slice(i).join('/');
      return params;
    }

    if (i >= urlSegments.length) return null;

    const us = urlSegments[i];

    if (ps !== undefined && ps.startsWith(':')) {
      params[ps.slice(1)] = us ?? '';
    } else if (ps !== us) {
      return null;
    }
  }

  // Pattern exhausted — url must also be exhausted
  if (urlSegments.length !== patternSegments.length) return null;

  return params;
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLocalhostOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return LOCALHOST_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * HOF: wraps a handler with auth verification.
 * Checks spawn_board cookie via the registered CookieVerifier, enforces CSRF
 * origin check on POST/PUT/DELETE, and populates ctx.user + ctx.scopes.
 */
export function requireAuth(handler: AuthHandler): Handler {
  return async (req, params, ctx) => {
    const method = req.method as Method;
    const origin = req.headers.get('origin') ?? undefined;
    const host = req.headers.get('host') ?? '';

    // CSRF origin check: POST/PUT/DELETE with an Origin that doesn't match Host
    // (localhost origins always pass)
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      if (origin !== undefined) {
        if (!isLocalhostOrigin(origin)) {
          let originHost: string;
          try {
            originHost = new URL(origin).host;
          } catch {
            return new Response(JSON.stringify({ error: 'origin_mismatch' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (originHost !== host) {
            return new Response(JSON.stringify({ error: 'origin_mismatch' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }
      }
    }

    // Verify cookie via injected verifier (B5 registers the real one)
    const cookieHeader = req.headers.get('cookie');
    const payload = cookieVerifier ? cookieVerifier(cookieHeader) : null;
    if (!payload) {
      return new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Populate scopes by enumerating user_roles directly. Post-build QA fix MF-3:
    // previously called canAccessAgentGroup(payload.user_id, '*') and hardcoded
    // allowed_group_ids=[], which silently locked scoped admins out of every
    // §2a-filtered query. The shared computeScopes helper enumerates real groups.
    // Lazy import keeps the auth/cookie dynamic-import wire-up clean (compute-scopes
    // depends on db/connection which can't be imported at module-init time before
    // initDb runs).
    const { computeScopes } = await import('./auth/compute-scopes.js');
    const scopes = computeScopes(payload.user_id);

    const user: User = {
      id: payload.user_id,
      kind: 'dashboard',
      display_name: null,
      created_at: new Date().toISOString(),
    };

    const authedCtx: AuthedRequestContext = {
      ...ctx,
      user,
      scopes,
    };

    return handler(req, params, authedCtx);
  };
}

/**
 * Dispatch an incoming request through the route table.
 * Returns Response (caller should write it) or null (handler wrote raw to nodeRes).
 */
export async function dispatch(
  req: Request,
  nodeReq: http.IncomingMessage,
  nodeRes: http.ServerResponse,
): Promise<Response | null> {
  const url = new URL(req.url);
  const urlPath = url.pathname;
  const method = req.method as Method;

  for (const route of routes) {
    if (route.method !== method) continue;
    const params = pathMatch(route.pattern, urlPath);
    if (params === null) continue;

    const ctx: RequestContext = { rawNodeReq: nodeReq, rawNodeRes: nodeRes };
    return route.handler(req, params, ctx);
  }

  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
