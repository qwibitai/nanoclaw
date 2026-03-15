import fs from 'fs';
import path from 'path';
import { request as httpsRequest } from 'https';
import { request as httpRequest, type RequestOptions } from 'http';
import { logger } from './logger.js';

/**
 * Module-level cache of secrets fetched from Solo Vault.
 * Populated by initSecrets() at startup, consulted by readEnvFile().
 */
const vaultCache: Record<string, string> = {};

/**
 * Fetch secrets from Solo Vault REST API and populate the vault cache.
 * Falls back gracefully to .env if Solo Vault is unreachable.
 * Must be called once at startup before any service initialization.
 */
export async function initSecrets(): Promise<void> {
  const adminKey =
    process.env.SOLO_VAULT_ADMIN_KEY || readEnvFileRaw('SOLO_VAULT_ADMIN_KEY');
  const vaultUrl =
    process.env.SOLO_VAULT_URL || readEnvFileRaw('SOLO_VAULT_URL') ||
    'https://api.vault.jeffreykeyser.net';
  const project =
    process.env.SOLO_VAULT_PROJECT || readEnvFileRaw('SOLO_VAULT_PROJECT') ||
    'nanoclaw';
  const environment =
    process.env.SOLO_VAULT_ENV || readEnvFileRaw('SOLO_VAULT_ENV') ||
    'production';

  if (!adminKey) {
    logger.warn(
      'SOLO_VAULT_ADMIN_KEY not set — using .env file as secret source',
    );
    return;
  }

  try {
    const secrets = await fetchVaultSecrets(
      vaultUrl,
      adminKey,
      project,
      environment,
    );
    for (const [key, value] of Object.entries(secrets)) {
      vaultCache[key] = value;
    }
    logger.info(
      { project, environment, secretCount: Object.keys(secrets).length },
      'Secrets loaded from Solo Vault',
    );
  } catch (err) {
    logger.warn(
      { err },
      'Solo Vault unreachable — falling back to .env file for secrets',
    );
  }
}

/**
 * Fetch secrets from the Solo Vault REST API.
 */
function fetchVaultSecrets(
  baseUrl: string,
  adminKey: string,
  project: string,
  environment: string,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const url = new URL(
      `/api/secrets?project=${encodeURIComponent(project)}&environment=${encodeURIComponent(environment)}`,
      baseUrl,
    );
    const isHttps = url.protocol === 'https:';
    const makeRequest = isHttps ? httpsRequest : httpRequest;

    const req = makeRequest(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          Accept: 'application/json',
        },
        timeout: 10000,
      } as RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `Solo Vault returned ${res.statusCode}: ${body.slice(0, 200)}`,
              ),
            );
            return;
          }
          try {
            const data = JSON.parse(body);
            // Support both { secrets: { KEY: VALUE } } and flat { KEY: VALUE }
            const secrets =
              data && typeof data.secrets === 'object' ? data.secrets : data;
            if (typeof secrets !== 'object' || secrets === null) {
              reject(new Error('Solo Vault returned invalid secrets format'));
              return;
            }
            resolve(secrets as Record<string, string>);
          } catch {
            reject(new Error('Solo Vault returned invalid JSON'));
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Solo Vault request timed out'));
    });
    req.end();
  });
}

/**
 * Read a single value directly from the .env file (used during init
 * before the vault cache is populated, e.g. for SOLO_VAULT_ADMIN_KEY).
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
 * Checks the Solo Vault cache first (populated by initSecrets()),
 * then falls back to the .env file. Does NOT load anything into
 * process.env — callers decide what to do with the values. This
 * keeps secrets out of the process environment so they don't leak
 * to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const remaining: string[] = [];

  // Check vault cache first
  for (const key of keys) {
    if (vaultCache[key]) {
      result[key] = vaultCache[key];
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
