import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import type { ContainerConfig } from './types.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

/**
 * Read provider config defaults from `.env`.
 *
 * Most Talon installs are single-tenant (one customer = one Talon instance),
 * so the operator just sets a few env vars and every group inherits the
 * same provider. Per-group `containerConfig` (DB-backed) still wins via
 * `mergeProviderConfig()` for the rare multi-tenant case.
 *
 * Recognised keys:
 *   TALON_PROVIDER          'anthropic' | 'ollama'
 *   TALON_OLLAMA_BASE_URL   e.g. https://x-11434.proxy.runpod.net
 *   TALON_OLLAMA_MODEL      e.g. llama3.2:latest
 *   TALON_OLLAMA_API_KEY    optional, defaults to "ollama"
 *   TALON_BLOCKED_HOSTS     comma-separated, e.g. "api.openai.com,generativelanguage.googleapis.com"
 *
 * Returns an empty `{}` when no provider keys are present — callers should
 * treat that as "no override, use defaults".
 */
export function loadProviderEnvDefaults(): Partial<ContainerConfig> {
  const env = readEnvFile([
    'TALON_PROVIDER',
    'TALON_OLLAMA_BASE_URL',
    'TALON_OLLAMA_MODEL',
    'TALON_OLLAMA_API_KEY',
    'TALON_BLOCKED_HOSTS',
  ]);

  const out: Partial<ContainerConfig> = {};

  const provider = env.TALON_PROVIDER?.toLowerCase();
  if (provider === 'anthropic' || provider === 'ollama') {
    out.provider = provider;
  } else if (provider) {
    logger.warn(
      { provider },
      'TALON_PROVIDER must be "anthropic" or "ollama" — ignoring',
    );
  }

  if (out.provider === 'ollama') {
    if (!env.TALON_OLLAMA_BASE_URL || !env.TALON_OLLAMA_MODEL) {
      logger.warn(
        'TALON_PROVIDER=ollama requires TALON_OLLAMA_BASE_URL and TALON_OLLAMA_MODEL — falling back to anthropic',
      );
      delete out.provider;
    } else {
      out.ollama = {
        baseUrl: env.TALON_OLLAMA_BASE_URL,
        model: env.TALON_OLLAMA_MODEL,
        ...(env.TALON_OLLAMA_API_KEY
          ? { apiKey: env.TALON_OLLAMA_API_KEY }
          : {}),
      };
    }
  }

  if (env.TALON_BLOCKED_HOSTS) {
    out.blockedHosts = env.TALON_BLOCKED_HOSTS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return out;
}

/**
 * Merge `.env` provider defaults with per-group container config.
 *
 * Precedence: defaults → .env → group config (group wins).
 *
 * - `provider`/`ollama`: per-group entry, if present, replaces the .env value
 *   wholesale (mixing fields would be confusing).
 * - `env`/`blockedHosts`: shallow-merged so a group can extend the base.
 * - `additionalMounts`/`timeout`: untouched — these are group-only by design.
 */
export function mergeProviderConfig(
  envDefaults: Partial<ContainerConfig>,
  groupConfig: ContainerConfig | undefined,
): ContainerConfig {
  const merged: ContainerConfig = { ...envDefaults, ...groupConfig };

  // Group's `provider`/`ollama` already won via spread above; nothing to do.

  // Shallow-merge env-var overlay so group can add keys without clobbering .env.
  if (envDefaults.env || groupConfig?.env) {
    merged.env = { ...envDefaults.env, ...groupConfig?.env };
  }

  // Union blockedHosts so group can add to (not replace) the .env list.
  if (envDefaults.blockedHosts || groupConfig?.blockedHosts) {
    merged.blockedHosts = [
      ...new Set([
        ...(envDefaults.blockedHosts ?? []),
        ...(groupConfig?.blockedHosts ?? []),
      ]),
    ];
  }

  return merged;
}
