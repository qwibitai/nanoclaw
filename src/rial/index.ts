/**
 * Public entry point for the rial integration.
 *
 *   handleRialMessage(senderJid, text) → reply | null
 *
 * The caller (see src/index.ts) gates this on the `RIAL_INTEGRATION_ENABLED`
 * feature flag (off by default). When `null` is returned, the existing
 * nanoclaw router takes over and treats the message as a regular agent
 * prompt — i.e. unknown commands and out-of-allowlist senders fall through.
 *
 * The function is designed so that nanoclaw can call it from inside the
 * existing message handler with minimal changes (5–10 lines of glue in
 * src/index.ts).
 */

import { logger } from '../logger.js';
import {
  isRialBusinessNumber,
  loadBusinessAllowlist,
  normalisePhone,
} from './allowlist.js';
import {
  CreateVerificationResponse,
  GetVerificationResponse,
  RialApiError,
  RialClient,
  logUnexpected,
} from './client.js';
import { HELP_TEXT, parseCommand } from './commands.js';
import { getDefaultRateLimiter, RateLimiter } from './rate-limit.js';
import { isRialEnabled, loadRialConfig, RialConfig } from './secrets.js';
import { TenantCache } from './tenant-cache.js';

let runtime: Runtime | null = null;

interface Runtime {
  config: RialConfig;
  client: RialClient;
  cache: TenantCache;
  rateLimiter: RateLimiter;
}

function getRuntime(): Runtime | null {
  if (runtime) return runtime;
  const config = loadRialConfig();
  if (!config) return null;
  runtime = {
    config,
    client: new RialClient({ config }),
    cache: new TenantCache(),
    rateLimiter: getDefaultRateLimiter(),
  };
  return runtime;
}

/** Test helper — wipes the lazily-built runtime. */
export function _resetRuntimeForTests(next?: Partial<Runtime>): void {
  runtime = next
    ? {
        config: next.config!,
        client: next.client!,
        cache: next.cache ?? new TenantCache(),
        rateLimiter: next.rateLimiter ?? new RateLimiter(),
      }
    : null;
}

/** Re-export for nanoclaw `src/index.ts` so it can guard the call site. */
export { isRialEnabled };

const SERVICE_UNAVAILABLE =
  'rial.: service unavailable, please retry in 1 minute / servicio no disponible, reintentá en 1 min.';
const NOT_LINKED =
  'This number is not linked to rial. yet. Link it from app.get-rial.com/settings/whatsapp first. / Este número aún no está vinculado.';

/**
 * Inbound entry point.
 *
 * Returns:
 *   - string: a reply to send back via the existing channel.
 *   - null:   not a rial command (or the sender isn't a business number /
 *             integration disabled / config missing) — caller should fall
 *             through to nanoclaw's existing routing.
 */
export async function handleRialMessage(
  senderJid: string,
  text: string,
): Promise<string | null> {
  if (!isRialEnabled()) return null;

  const command = parseCommand(text);
  // Unknown text is never claimed by rial — let the existing agent handle it.
  if (command.kind === 'unknown') return null;

  const phone = normalisePhone(senderJid);
  if (!phone) return null;

  const rt = getRuntime();
  if (!rt) {
    // Config missing but flag was on — log already happened in loadRialConfig.
    return null;
  }

  // Allowlist gate: only registered business numbers go through rial.
  // For everything else we fall through (return null) so nanoclaw's
  // existing routing remains untouched.
  if (!isRialBusinessNumber(phone)) {
    return null;
  }

  // Rate limit.
  const rl = rt.rateLimiter.check(phone);
  if (!rl.allowed) {
    return `Too many requests, retry in ${rl.retryAfterSeconds}s.`;
  }

  if (command.kind === 'help') return HELP_TEXT;

  // Tenant resolution (cached) — needed for /link and /status.
  let tenantId = rt.cache.get(phone);
  if (!tenantId) {
    try {
      const resp = await rt.client.resolveTenant(phone);
      if (!resp || typeof resp.tenantId !== 'string' || !resp.tenantId) {
        logger.warn({ phone }, 'rial: resolveTenant returned no tenantId');
        return SERVICE_UNAVAILABLE;
      }
      tenantId = resp.tenantId;
      rt.cache.set(phone, tenantId);
    } catch (err: unknown) {
      if (err instanceof RialApiError) {
        if (err.kind === 'not-found') return NOT_LINKED;
        logger.warn(
          { kind: err.kind, status: err.status },
          'rial: resolveTenant failed',
        );
        return SERVICE_UNAVAILABLE;
      }
      logUnexpected('resolveTenant', err);
      return SERVICE_UNAVAILABLE;
    }
  }

  if (command.kind === 'link') {
    return await handleLink(rt, tenantId, phone);
  }

  // command.kind === 'status'
  return await handleStatus(rt, command.id);
}

async function handleLink(
  rt: Runtime,
  tenantId: string,
  phone: string,
): Promise<string> {
  let resp: CreateVerificationResponse;
  try {
    resp = await rt.client.createVerification(tenantId, phone);
  } catch (err: unknown) {
    if (err instanceof RialApiError) {
      if (err.kind === 'unauthorized') {
        // The tenant scoping has gone stale — drop the cache so the next
        // attempt re-resolves.
        rt.cache.delete(phone);
        return SERVICE_UNAVAILABLE;
      }
      if (err.kind === 'rate-limited') {
        return 'Too many verification requests on rial.; please retry in a minute.';
      }
      logger.warn(
        { kind: err.kind, status: err.status },
        'rial: createVerification failed',
      );
      return SERVICE_UNAVAILABLE;
    }
    logUnexpected('createVerification', err);
    return SERVICE_UNAVAILABLE;
  }

  const ttl = Number.isFinite(resp.expiresInMinutes)
    ? resp.expiresInMinutes
    : 15;
  return `Verify URL: ${resp.url}\n\nExpires in ${ttl}m. / Expira en ${ttl}min.`;
}

async function handleStatus(rt: Runtime, id: string): Promise<string> {
  let resp: GetVerificationResponse;
  try {
    resp = await rt.client.getVerification(id);
  } catch (err: unknown) {
    if (err instanceof RialApiError) {
      if (err.kind === 'not-found') return `Verification ${id} not found.`;
      logger.warn(
        { kind: err.kind, status: err.status },
        'rial: getVerification failed',
      );
      return SERVICE_UNAVAILABLE;
    }
    logUnexpected('getVerification', err);
    return SERVICE_UNAVAILABLE;
  }

  if (resp.status === 'pending' || resp.status === 'processing') {
    return `Verification ${resp.id}: still processing. / aún en proceso.`;
  }
  if (resp.status === 'failed') {
    return `Verification ${resp.id}: failed. ${resp.message ?? ''}`.trim();
  }
  // complete
  const verdict = resp.verdict ?? 'inconclusive';
  return `Verification ${resp.id}: ${verdict}.${
    resp.message ? `\n${resp.message}` : ''
  }`;
}

/** Exposed so `src/index.ts` can prime the allowlist on boot. */
export function preloadAllowlist(): void {
  loadBusinessAllowlist();
}
