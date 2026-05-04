/**
 * HTTP client for rial-platform.
 *
 * All requests are signed with X-Bot-Auth:
 *   X-Bot-Auth: <ts>:<sha256_hmac(secret, ts + "\n" + method + "\n" + path + "\n" + body_sha256)>
 *
 * Note: only the path *segment* (not the host or query string) is part
 * of the signed message — see rial-platform/docs/spec-whatsapp-flow.md.
 *
 * Errors thrown by this module are typed via RialApiError so the caller
 * can map them to user-facing replies.
 */

import { createHash, createHmac } from 'node:crypto';

import { logger } from '../logger.js';
import { RialConfig } from './secrets.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface RialClientOptions {
  config: RialConfig;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override clock for deterministic HMACs in tests. */
  now?: () => number;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface ResolveTenantResponse {
  tenantId: string;
  /** Optional — rial-platform may issue a short-lived tenant-scoped token. */
  token?: string;
  expiresAt?: string;
}

export interface CreateVerificationResponse {
  id: string;
  url: string;
  /** Minutes until the verify link expires. */
  expiresInMinutes: number;
}

export interface GetVerificationResponse {
  id: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  verdict?: 'clean' | 'recapture' | 'tampered' | 'inconclusive';
  message?: string;
}

/** Discriminator for caller-side handling. */
export type RialApiErrorKind =
  | 'not-found'
  | 'unauthorized'
  | 'rate-limited'
  | 'timeout'
  | 'server-error'
  | 'network'
  | 'invalid-response';

export class RialApiError extends Error {
  constructor(
    public readonly kind: RialApiErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RialApiError';
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

export function buildAuthHeader(
  secret: string,
  ts: number,
  method: string,
  path: string,
  rawBody: string,
): string {
  const bodyHash = sha256Hex(rawBody);
  const message = `${ts}\n${method}\n${path}\n${bodyHash}`;
  const sig = hmacSha256Hex(secret, message);
  return `${ts}:${sig}`;
}

export class RialClient {
  private readonly config: RialConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(opts: RialClientOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!this.fetchImpl) {
      throw new Error('rial: global fetch unavailable; Node 22+ required');
    }
  }

  private async call<T>(
    method: 'GET' | 'POST',
    pathWithQuery: string,
    body?: object,
  ): Promise<T> {
    const ts = Math.floor(this.now() / 1000);
    const rawBody = body !== undefined ? JSON.stringify(body) : '';
    // The HMAC covers only the path component, not the query string —
    // matches what rial-platform verifies (see spec-whatsapp-flow.md).
    const pathOnly = pathWithQuery.split('?')[0] ?? pathWithQuery;
    const auth = buildAuthHeader(
      this.config.hmacSecret,
      ts,
      method,
      pathOnly,
      rawBody,
    );

    const url = `${this.config.apiBaseUrl}${pathWithQuery}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.config.userAgent,
          'X-Bot-Auth': auth,
        },
        body: method === 'POST' ? rawBody : undefined,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new RialApiError(
          'timeout',
          `rial-platform request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new RialApiError(
        'network',
        `rial-platform network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const kind: RialApiErrorKind =
        res.status === 404
          ? 'not-found'
          : res.status === 401 || res.status === 403
            ? 'unauthorized'
            : res.status === 429
              ? 'rate-limited'
              : res.status >= 500
                ? 'server-error'
                : 'invalid-response';
      throw new RialApiError(
        kind,
        `rial-platform ${method} ${pathOnly} → ${res.status} ${text.slice(0, 200)}`,
        res.status,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err: unknown) {
      throw new RialApiError(
        'invalid-response',
        `rial-platform returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return json as T;
  }

  async resolveTenant(waPhoneE164: string): Promise<ResolveTenantResponse> {
    const path = `/v1/wa-links/resolve?wa_phone_e164=${encodeURIComponent(waPhoneE164)}`;
    return this.call<ResolveTenantResponse>('GET', path);
  }

  async createVerification(
    tenantId: string,
    waPhoneE164: string,
  ): Promise<CreateVerificationResponse> {
    return this.call<CreateVerificationResponse>('POST', '/v1/wa-links/init', {
      tenantId,
      waPhoneE164,
    });
  }

  async getVerification(id: string): Promise<GetVerificationResponse> {
    const path = `/v1/wa-links/${encodeURIComponent(id)}`;
    return this.call<GetVerificationResponse>('GET', path);
  }
}

/**
 * Best-effort: log unexpected errors to keep observability without crashing
 * the caller. Returns null to signal the caller should fall through.
 */
export function logUnexpected(scope: string, err: unknown): void {
  logger.error({ scope, err }, 'rial: unexpected error');
}
