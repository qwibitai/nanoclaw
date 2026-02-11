import fs from 'fs';
import yaml from 'js-yaml';
import type Database from 'better-sqlite3';

import { TENANT_CONFIG_PATH } from './config.js';
import { logger } from './logger.js';

export interface TenantConfig {
  mla_name: string;
  constituency: string;
  complaint_id_prefix: string;
  wa_admin_group_jid: string;
  admin_phones?: string[];
  languages: string[];
  daily_msg_limit: number;
  office_phone: string;
  office_address: string;
  website_domain: string;
}

const REQUIRED_FIELDS: (keyof TenantConfig)[] = [
  'mla_name',
  'constituency',
  'complaint_id_prefix',
  'languages',
  'office_phone',
];

const DEFAULTS: Partial<TenantConfig> = {
  daily_msg_limit: 20,
  office_address: '',
  website_domain: '',
};

let cachedConfig: TenantConfig | null = null;

/**
 * Load tenant configuration from a YAML file.
 * When called without arguments, uses TENANT_CONFIG_PATH from config.ts.
 * If the default config file is missing, returns hardcoded defaults (backward compat).
 * If an explicit configPath is provided and missing, throws an error.
 */
export function loadTenantConfig(configPath?: string): TenantConfig {
  if (cachedConfig) return cachedConfig;

  const resolvedPath = configPath ?? TENANT_CONFIG_PATH;
  const isExplicitPath = configPath !== undefined;

  if (!fs.existsSync(resolvedPath)) {
    if (isExplicitPath) {
      throw new Error(
        `Tenant config file not found: ${resolvedPath}`,
      );
    }
    logger.warn(
      { path: resolvedPath },
      'Tenant config file not found, using defaults',
    );
    cachedConfig = getDefaultConfig();
    return cachedConfig;
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');

  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse YAML config at ${resolvedPath}: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `Failed to parse YAML config at ${resolvedPath}: file did not produce an object`,
    );
  }

  // Apply defaults before validation
  const merged: Record<string, unknown> = { ...DEFAULTS, ...parsed };

  // Validate required fields
  for (const field of REQUIRED_FIELDS) {
    const value = merged[field];
    if (value === undefined || value === null) {
      throw new Error(
        `Tenant config validation error: required field "${field}" is missing in ${resolvedPath}`,
      );
    }
  }

  // Validate languages is a non-empty array
  if (!Array.isArray(merged.languages) || merged.languages.length === 0) {
    throw new Error(
      `Tenant config validation error: "languages" must be a non-empty array in ${resolvedPath}`,
    );
  }

  const config: TenantConfig = {
    mla_name: String(merged.mla_name),
    constituency: String(merged.constituency),
    complaint_id_prefix: String(merged.complaint_id_prefix),
    wa_admin_group_jid: String(merged.wa_admin_group_jid ?? ''),
    admin_phones: Array.isArray(merged.admin_phones)
      ? (merged.admin_phones as unknown[]).map(String)
      : [],
    languages: (merged.languages as unknown[]).map(String),
    daily_msg_limit: Number(merged.daily_msg_limit),
    office_phone: String(merged.office_phone ?? ''),
    office_address: String(merged.office_address ?? ''),
    website_domain: String(merged.website_domain ?? ''),
  };

  cachedConfig = config;
  return cachedConfig;
}

/**
 * Cache tenant config key-value pairs into the tenant_config SQLite table.
 * Shell scripts can read these at runtime via:
 *   sqlite3 store/messages.db "SELECT value FROM tenant_config WHERE key='complaint_id_prefix'"
 */
export function cacheTenantConfigToDb(
  db: Database.Database,
  config: TenantConfig,
): void {
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO tenant_config (key, value) VALUES (?, ?)',
  );

  const entries: [string, string][] = [
    ['mla_name', config.mla_name],
    ['constituency', config.constituency],
    ['complaint_id_prefix', config.complaint_id_prefix],
    ['wa_admin_group_jid', config.wa_admin_group_jid],
    ['admin_phones', (config.admin_phones ?? []).join(',')],
    ['languages', config.languages.join(',')],
    ['daily_msg_limit', String(config.daily_msg_limit)],
    ['office_phone', config.office_phone],
    ['office_address', config.office_address],
    ['website_domain', config.website_domain],
  ];

  const insertAll = db.transaction(() => {
    for (const [key, value] of entries) {
      upsert.run(key, value);
    }
  });

  insertAll();
}

/**
 * Replace template variables like {mla_name}, {constituency} etc. in a string.
 * Only replaces known config keys; unknown {variables} are left as-is.
 */
export function injectTemplateVariables(
  template: string,
  config: TenantConfig,
): string {
  const replacements: Record<string, string> = {
    mla_name: config.mla_name,
    constituency: config.constituency,
    complaint_id_prefix: config.complaint_id_prefix,
    wa_admin_group_jid: config.wa_admin_group_jid,
    admin_phones: (config.admin_phones ?? []).join(','),
    office_phone: config.office_phone,
    office_address: config.office_address,
    website_domain: config.website_domain,
    daily_msg_limit: String(config.daily_msg_limit),
  };

  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

function getDefaultConfig(): TenantConfig {
  return {
    mla_name: 'Rahul Kul',
    constituency: 'Daund',
    complaint_id_prefix: 'RK',
    wa_admin_group_jid: '',
    admin_phones: [],
    languages: ['mr', 'hi', 'en'],
    daily_msg_limit: 20,
    office_phone: '',
    office_address: '',
    website_domain: '',
  };
}

/**
 * Clear cached config (for testing).
 */
export function _clearConfigCache(): void {
  cachedConfig = null;
}
