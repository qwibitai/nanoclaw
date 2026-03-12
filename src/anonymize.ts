import fs from 'fs';
import path from 'path';

import { ANONYMIZE_CONFIG_DIR, escapeRegex } from './config.js';
import { logger } from './logger.js';

export interface AnonymizeConfig {
  enabled: boolean;
  piiCheck?: boolean;
  piiModel?: string;
  mappings: Record<string, string>;
}

interface CompiledMapping {
  pattern: RegExp;
  replacement: string;
}

interface CachedEntry {
  config: AnonymizeConfig;
  forward: CompiledMapping[];
  inverse: CompiledMapping[];
}

const configCache = new Map<string, CachedEntry | null>();

/**
 * Compile mappings into sorted regex patterns (longest key first).
 * Uses word-boundary matching so "Olivia" matches "Olivia's" and
 * "Olivia," but not "OliviaExtra".
 */
function compileMappings(mappings: Record<string, string>): CompiledMapping[] {
  return Object.entries(mappings)
    .sort(([a], [b]) => b.length - a.length)
    .map(([key, value]) => ({
      pattern: new RegExp(`\\b${escapeRegex(key)}\\b`, 'gi'),
      replacement: value,
    }));
}

function applyMappings(text: string, compiled: CompiledMapping[]): string {
  let result = text;
  for (const { pattern, replacement } of compiled) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function configPath(groupFolder: string): string {
  return path.join(ANONYMIZE_CONFIG_DIR, `${groupFolder}.json`);
}

export function loadAnonymizeConfig(
  groupFolder: string,
  pathOverride?: string,
): AnonymizeConfig | null {
  const cacheKey = pathOverride ?? groupFolder;
  const cached = configCache.get(cacheKey);
  if (cached !== undefined) return cached?.config ?? null;

  const result = loadAnonymizeConfigUncached(groupFolder, pathOverride);
  if (result) {
    const inverted = Object.fromEntries(
      Object.entries(result.mappings).map(([k, v]) => [v, k]),
    );
    configCache.set(cacheKey, {
      config: result,
      forward: compileMappings(result.mappings),
      inverse: compileMappings(inverted),
    });
  } else {
    configCache.set(cacheKey, null);
  }
  return result;
}

function loadAnonymizeConfigUncached(
  groupFolder: string,
  pathOverride?: string,
): AnonymizeConfig | null {
  const filePath = pathOverride ?? configPath(groupFolder);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logger.warn({ err, path: filePath }, 'anonymize: cannot read config');
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'anonymize: invalid JSON');
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.enabled !== 'boolean') {
    logger.warn({ path: filePath }, 'anonymize: missing enabled field');
    return null;
  }
  if (!obj.enabled) return null;

  if (!obj.mappings || typeof obj.mappings !== 'object') {
    logger.warn({ path: filePath }, 'anonymize: missing mappings object');
    return null;
  }

  const mappings = obj.mappings as Record<string, string>;

  // Validate no circular mappings (pseudonym value also appears as a key)
  const keys = new Set(Object.keys(mappings).map((k) => k.toLowerCase()));
  for (const value of Object.values(mappings)) {
    if (keys.has(value.toLowerCase())) {
      logger.warn(
        { path: filePath, value },
        'anonymize: pseudonym collides with a mapping key — rejected',
      );
      return null;
    }
  }

  return {
    enabled: true,
    piiCheck: obj.piiCheck === true,
    piiModel: typeof obj.piiModel === 'string' ? obj.piiModel : undefined,
    mappings,
  };
}

/** Replace real values with pseudonyms. */
export function anonymize(text: string, config: AnonymizeConfig): string {
  const cacheKey = findCacheKey(config);
  if (cacheKey) return applyMappings(text, configCache.get(cacheKey)!.forward);
  return applyMappings(text, compileMappings(config.mappings));
}

/** Replace pseudonyms with real values (inverted mappings). */
export function deanonymize(text: string, config: AnonymizeConfig): string {
  const cacheKey = findCacheKey(config);
  if (cacheKey) return applyMappings(text, configCache.get(cacheKey)!.inverse);
  const inverted = Object.fromEntries(
    Object.entries(config.mappings).map(([k, v]) => [v, k]),
  );
  return applyMappings(text, compileMappings(inverted));
}

/** Find cache key for a config object (by reference equality). */
function findCacheKey(config: AnonymizeConfig): string | undefined {
  for (const [key, entry] of configCache) {
    if (entry?.config === config) return key;
  }
  return undefined;
}

/**
 * Add a new mapping entry to the config file on disk.
 * Reads the current file, adds the entry, writes it back.
 * Invalidates the cache for the affected group.
 */
export function addMapping(
  groupFolder: string,
  real: string,
  pseudonym: string,
  pathOverride?: string,
): void {
  const filePath = pathOverride ?? configPath(groupFolder);

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    logger.warn(
      { path: filePath },
      'anonymize: cannot read config for addMapping',
    );
    return;
  }

  const mappings = (obj.mappings ?? {}) as Record<string, string>;
  mappings[real] = pseudonym;
  obj.mappings = mappings;

  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  configCache.delete(pathOverride ?? groupFolder);
  logger.info({ real, pseudonym, groupFolder }, 'anonymize: added mapping');
}
