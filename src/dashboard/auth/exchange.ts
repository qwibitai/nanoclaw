import crypto from 'crypto';
import { consumeDashboardToken } from '../db/dashboard-tokens.js';
import { resolveServerKey, buildSetCookie } from './cookie.js';
import { register } from '../router.js';
import type { Handler } from '../router.js';

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLocalhostOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return LOCALHOST_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function checkOrigin(req: Request): Response | null {
  const method = req.method;
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    const origin = req.headers.get('origin') ?? undefined;
    const host = req.headers.get('host') ?? '';
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
  return null;
}

export const exchangeHandler: Handler = async (req) => {
  const originDeny = checkOrigin(req);
  if (originDeny) return originDeny;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).token !== 'string') {
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rawToken = (body as { token: string }).token;
  const serverKey = resolveServerKey();
  const tokenHmac = crypto.createHmac('sha256', serverKey).update(rawToken).digest('hex');

  const record = consumeDashboardToken(tokenHmac);
  if (!record) {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Detect whether the request was made over HTTPS or to a loopback host.
  // Browsers refuse Secure cookies over plain HTTP for non-loopback hosts; if
  // the dashboard is reached at http://<lan-ip>:3000, we must omit Secure or
  // the cookie silently doesn't get set and the user loops back to AuthGate.
  // Reverse proxies set X-Forwarded-Proto when terminating TLS in front of us.
  const xfp = req.headers.get('x-forwarded-proto');
  const hostHeader = req.headers.get('host') ?? '';
  const hostname = hostHeader.split(':')[0] ?? '';
  const isLoopbackHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const requestIsHttps = xfp === 'https' || isLoopbackHost;

  const cookie = buildSetCookie({ user_id: record.user_id, expires_at: record.expires_at }, serverKey, {
    secure: requestIsHttps,
  });

  return new Response(JSON.stringify({ user_id: record.user_id, expires_at: record.expires_at }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
  });
};

// Side-effect registration
register('POST', '/dashboard/api/auth/exchange', exchangeHandler);
