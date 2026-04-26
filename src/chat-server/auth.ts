import http from 'http';
import { execFile } from 'child_process';
import { timingSafeEqual } from 'crypto';

import { logger } from '../logger.js';

const CHAT_SERVER_TOKEN = process.env.CHAT_SERVER_TOKEN || '';
const TRUSTED_PROXY_RAW = (process.env.TRUSTED_PROXY_IPS || '').trim();

// Trusted proxy modes:
//   "auto" — accept identity from any platform-managed proxy, detected per-request.
//            SECURITY: "auto" checks for platform companion headers (Azure EasyAuth,
//            Cloudflare Access) but does NOT cryptographically verify them. This is
//            safe ONLY when the server is exclusively reachable through the proxy.
//            If the server is also directly accessible (e.g. during development),
//            an attacker on the network can forge these headers. Use explicit IPs
//            or CIDR notation instead for defense-in-depth.
//   "*"    — trust the configured header from any source IP (most permissive)
//   IPs    — explicit IP/CIDR allowlist (recommended)
const TRUST_ANY_PLATFORM =
  TRUSTED_PROXY_RAW === 'auto' || TRUSTED_PROXY_RAW === '*';

const TRUSTED_PROXY_ENTRIES = TRUST_ANY_PLATFORM
  ? []
  : TRUSTED_PROXY_RAW.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

const TRUSTED_PROXY_HEADER = (
  process.env.TRUSTED_PROXY_HEADER || 'x-forwarded-user'
).toLowerCase();

const PLATFORM_HEADERS: Array<{
  identity: string;
  verify: string;
  name: string;
}> = [
  // Azure App Service EasyAuth — x-ms-client-principal is a signed blob
  // that only the platform can inject
  {
    identity: 'x-ms-client-principal-name',
    verify: 'x-ms-client-principal',
    name: 'Azure EasyAuth',
  },
  // Cloudflare Access — Cf-Access-Jwt-Assertion accompanies the email header
  {
    identity: 'cf-access-authenticated-user-email',
    verify: 'cf-access-jwt-assertion',
    name: 'Cloudflare Access',
  },
];

function ipToInt(ip: string): number {
  return (
    ip
      .split('.')
      .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
  );
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(network) & mask);
}

function isTrustedProxyIp(ip: string): boolean {
  for (const entry of TRUSTED_PROXY_ENTRIES) {
    if (entry.includes('/')) {
      if (isIpInCidr(ip, entry)) return true;
    } else {
      if (ip === entry) return true;
    }
  }
  return false;
}

function isLocalhost(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/, '');
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

/** Constant-time token comparison. Falls back to false for length mismatch
 *  so an attacker can't probe the token's length via timing. */
function safeTokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function tailscaleWhois(ip: string): Promise<string | null> {
  const cleanIp = ip.replace(/^::ffff:/, '');
  return new Promise((resolve) => {
    execFile(
      'tailscale',
      ['whois', '--json', cleanIp],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const login =
            data?.UserProfile?.LoginName ||
            data?.Node?.Hostinfo?.Hostname ||
            null;
          resolve(login);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function authenticateTrustedProxy(
  req: http.IncomingMessage,
  remoteIp: string,
): { ok: boolean; identity?: string } | null {
  const cleanIp = remoteIp.replace(/^::ffff:/, '');

  // Auto mode: detect platform-managed proxies from request headers
  if (TRUST_ANY_PLATFORM) {
    for (const ph of PLATFORM_HEADERS) {
      const identity = req.headers[ph.identity];
      const proof = req.headers[ph.verify];
      if (identity && proof) {
        const user = Array.isArray(identity) ? identity[0] : identity;
        logger.debug(
          { identity: user, platform: ph.name },
          'Platform proxy auth',
        );
        return { ok: true, identity: user };
      }
    }
    // In auto mode with no platform headers, fall back to configured header
    const rawUser = req.headers[TRUSTED_PROXY_HEADER];
    const user = Array.isArray(rawUser) ? rawUser[0] : rawUser;
    if (user) {
      logger.debug(
        { identity: user, remoteIp: cleanIp },
        'Trusted proxy auth (auto fallback)',
      );
      return { ok: true, identity: user };
    }
    return null;
  }

  // Explicit IP mode
  if (TRUSTED_PROXY_ENTRIES.length === 0) return null;
  if (!isTrustedProxyIp(cleanIp)) return null;
  const rawUser = req.headers[TRUSTED_PROXY_HEADER];
  const user = Array.isArray(rawUser) ? rawUser[0] : rawUser;
  if (!user) return null;
  logger.debug({ identity: user, remoteIp: cleanIp }, 'Trusted proxy auth');
  return { ok: true, identity: user };
}

/** Emit a startup warning if TRUSTED_PROXY_IPS is set to "auto" — headers
 *  are not cryptographically verified in that mode. Call once from
 *  startChatServer() so installers see the message in service logs. */
export function warnIfAutoProxyTrust(): void {
  if (TRUSTED_PROXY_RAW === 'auto') {
    logger.warn(
      'Trusted proxy "auto" mode — headers are NOT cryptographically verified. ' +
        'Ensure this server is ONLY reachable through your proxy (Azure/Cloudflare). ' +
        'Direct access allows header forgery. Without platform headers, falls back to ' +
        'trusting any source IP with the configured header (equivalent to "*" mode).',
    );
  }
}

export async function authenticateRequest(
  req: http.IncomingMessage,
): Promise<{ ok: boolean; identity?: string; reason?: string }> {
  const remoteIp = (req.socket.remoteAddress ?? '127.0.0.1').replace(
    /^::ffff:/,
    '',
  );

  const localUser = process.env.USER || process.env.USERNAME || 'user';

  // 1. Bearer token from Authorization header or WebSocket subprotocol.
  //    The PWA passes the token as `Sec-WebSocket-Protocol: bearer.<token>`
  //    when opening /ws — keeps the secret out of URLs (and therefore out of
  //    proxy access logs and browser history).
  const authHeader = req.headers.authorization;
  let providedToken: string | undefined;
  if (authHeader?.startsWith('Bearer ')) {
    providedToken = authHeader.slice(7);
  } else {
    const wsProto = req.headers['sec-websocket-protocol'];
    if (wsProto) {
      const protos = (Array.isArray(wsProto) ? wsProto.join(',') : wsProto)
        .split(',')
        .map((s) => s.trim());
      const bearer = protos.find((p) => p.startsWith('bearer.'));
      if (bearer) providedToken = bearer.slice('bearer.'.length);
    }
  }

  if (CHAT_SERVER_TOKEN && providedToken && safeTokenEqual(providedToken, CHAT_SERVER_TOKEN)) {
    return { ok: true, identity: localUser };
  }

  // 2. Localhost always passes
  if (isLocalhost(remoteIp)) {
    return { ok: true, identity: localUser };
  }

  // 3. Trusted proxy headers (before tailscale — proxy is the auth authority)
  const proxyResult = authenticateTrustedProxy(req, remoteIp);
  if (proxyResult?.ok) {
    return { ok: true, identity: proxyResult.identity };
  }

  // 4. Tailscale identity
  const tsUser = await tailscaleWhois(remoteIp);
  if (tsUser) {
    return { ok: true, identity: tsUser };
  }

  return { ok: false, reason: 'Unauthorized' };
}
