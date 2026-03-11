import fs from 'fs';
import path from 'path';

import { ANONYMIZE_CONFIG_DIR } from './config.js';
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

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile mappings into sorted regex patterns (longest key first).
 * Uses word-boundary matching so "Olivia" matches "Olivia's" and
 * "Olivia," but not "OliviaExtra".
 */
function compileMappings(mappings: Record<string, string>): CompiledMapping[] {
  return Object.entries(mappings)
    .sort(([a], [b]) => b.length - a.length)
    .map(([key, value]) => ({
      pattern: new RegExp(`\\b${escapeRegExp(key)}\\b`, 'gi'),
      replacement: value,
    }));
}

function configPath(groupFolder: string): string {
  return path.join(ANONYMIZE_CONFIG_DIR, `${groupFolder}.json`);
}

export function loadAnonymizeConfig(
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
  const compiled = compileMappings(config.mappings);
  let result = text;
  for (const { pattern, replacement } of compiled) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Replace pseudonyms with real values (inverted mappings). */
export function deanonymize(text: string, config: AnonymizeConfig): string {
  const inverted: Record<string, string> = {};
  for (const [real, pseudonym] of Object.entries(config.mappings)) {
    inverted[pseudonym] = real;
  }
  const compiled = compileMappings(inverted);
  let result = text;
  for (const { pattern, replacement } of compiled) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Add a new mapping entry to the config file on disk.
 * Reads the current file, adds the entry, writes it back.
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
  logger.info({ real, pseudonym, groupFolder }, 'anonymize: added mapping');
}
