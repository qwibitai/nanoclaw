import fs from 'fs';
import path from 'path';
import { request as httpsRequest } from 'https';
import { request as httpRequest, type RequestOptions } from 'http';
import { logger } from './logger.js';

/**
 * TTL-based cache entry for secrets fetched from Solo Vault.
 */
interface CacheEntry {
  value: string;
  expiresAt: number;
}

/** Module-level cache of secrets fetched from Solo Vault with TTL. */
const vaultCache = new Map<string, CacheEntry>();

/** Resolved vault configuration (set once by initSecrets). */
let vaultConfig: {
  url: string;
  token: string;
  project: string;
  environment: string;
  ttl: number;
} | null = null;

/**
 * Initialize Solo Vault configuration.
 * Must be called once at startup before any service initialization.
 * Falls back gracefully to .env if SOLO_VAULT_TOKEN is not set.
 */
export async function initSecrets(): Promise<void> {
  const token =
    process.env.SOLO_VAULT_TOKEN ||
    readEnvFileRaw('SOLO_VAULT_TOKEN') ||
    process.env.SOLO_VAULT_ADMIN_KEY ||
    readEnvFileRaw('SOLO_VAULT_ADMIN_KEY');
  const url =
    process.env.SOLO_VAULT_URL ||
    readEnvFileRaw('SOLO_VAULT_URL') ||
    'https://api.vault.jeffreykeyser.net';
  const project =
    process.env.SOLO_VAULT_PROJECT ||
    readEnvFileRaw('SOLO_VAULT_PROJECT') ||
    'nanoclaw';
  const environment =
    process.env.SOLO_VAULT_ENV ||
    readEnvFileRaw('SOLO_VAULT_ENV') ||
    'production';
  const ttl = 5 * 60 * 1000; // 5 minutes

  if (!token) {
    logger.warn(
      'SOLO_VAULT_TOKEN not set — using .env file as secret source',
    );
    return;
  }

  vaultConfig = { url, token, project, environment, ttl };
  logger.info(
    { project, environment, vaultUrl: url },
    'Solo Vault configured for on-demand secret fetching',
  );
}

/**
 * Fetch a single secret from the Solo Vault REST API.
 * Uses GET /v1/secrets/:project/:env/:key
 */
function fetchVaultSecret(
  key: string,
): Promise<string | undefined> {
  if (!vaultConfig) return Promise.resolve(undefined);

  const { url: baseUrl, token, project, environment } = vaultConfig;

  return new Promise((resolve, reject) => {
    const url = new URL(
      `/v1/secrets/${encodeURIComponent(project)}/${encodeURIComponent(environment)}/${encodeURIComponent(key)}`,
      baseUrl,
    );
    const isHttps = url.protocol === 'https:';
    const makeRequest = isHttps ? httpsRequest : httpRequest;

    const req = makeRequest(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        timeout: 10000,
      } as RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode === 404) {
            resolve(undefined);
            return;
          }
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `Solo Vault returned ${res.statusCode} for key "${key}": ${body.slice(0, 200)}`,
              ),
            );
            return;
          }
          try {
            const data = JSON.parse(body);
            // Support { value: "..." } or { secret: { value: "..." } }
            const value =
              typeof data.value === 'string'
                ? data.value
                : data.secret?.value;
            if (typeof value !== 'string') {
              reject(
                new Error(
                  `Solo Vault returned unexpected format for key "${key}"`,
                ),
              );
              return;
            }
            resolve(value);
          } catch {
            reject(new Error(`Solo Vault returned invalid JSON for key "${key}"`));
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Solo Vault request timed out for key "${key}"`));
    });
    req.end();
  });
}

/**
 * Refresh vault cache entries for the given keys.
 * Fetches from Solo Vault any keys that are missing or expired in the cache.
 * Falls back silently to .env for keys that cannot be fetched.
 */
export async function refreshSecrets(keys: string[]): Promise<void> {
  if (!vaultConfig) return;

  const now = Date.now();
  const staleKeys = keys.filter((key) => {
    const entry = vaultCache.get(key);
    return !entry || now >= entry.expiresAt;
  });

  if (staleKeys.length === 0) return;

  const results = await Promise.allSettled(
    staleKeys.map(async (key) => {
      const value = await fetchVaultSecret(key);
      return { key, value };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.value !== undefined) {
      vaultCache.set(result.value.key, {
        value: result.value.value,
        expiresAt: now + vaultConfig.ttl,
      });
    } else if (result.status === 'rejected') {
      logger.warn(
        { err: result.reason, key: (result as any).value?.key },
        'Failed to fetch secret from Solo Vault — will use .env fallback',
      );
    }
  }
}

/**
 * Read a single value directly from the .env file (used during init
 * before the vault cache is populated, e.g. for SOLO_VAULT_TOKEN).
 */
function readEnvFileRaw(key: string): string | undefined {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    return undefined;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    if (trimmed.slice(0, eqIdx).trim() !== key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

/**
 * Parse the .env file and return values for the requested keys.
 * Checks the Solo Vault cache first (populated by initSecrets/refreshSecrets),
 * then falls back to the .env file. Does NOT load anything into
 * process.env — callers decide what to do with the values. This
 * keeps secrets out of the process environment so they don't leak
 * to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const remaining: string[] = [];
  const now = Date.now();

  // Check vault cache first (only valid/non-expired entries)
  for (const key of keys) {
    const entry = vaultCache.get(key);
    if (entry && now < entry.expiresAt) {
      result[key] = entry.value;
    } else {
      remaining.push(key);
    }
  }

  // Fall back to .env file for keys not in vault
  if (remaining.length === 0) return result;

  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return result;
  }

  const wanted = new Set(remaining);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

/** Check whether the vault is configured (token is set). */
export function isVaultConfigured(): boolean {
  return vaultConfig !== null;
}
