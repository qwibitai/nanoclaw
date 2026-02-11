import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';

import {
  loadTenantConfig,
  cacheTenantConfigToDb,
  injectTemplateVariables,
  _clearConfigCache,
  type TenantConfig,
} from './tenant-config.js';

let tmpDir: string;

function writeTenantYaml(config: Record<string, unknown>): string {
  const configDir = path.join(tmpDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const filePath = path.join(configDir, 'tenant.yaml');
  fs.writeFileSync(filePath, yaml.dump(config), 'utf-8');
  return filePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-config-test-'));
  _clearConfigCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Loading valid YAML config ---

describe('loadTenantConfig', () => {
  it('loads a valid YAML config successfully', () => {
    const filePath = writeTenantYaml({
      mla_name: 'Rahul Kul',
      constituency: 'Daund',
      complaint_id_prefix: 'RK',
      wa_admin_group_jid: '120363001234@g.us',
      languages: ['mr', 'hi', 'en'],
      daily_msg_limit: 30,
      office_phone: '+912112345678',
      office_address: '123 Main St',
      website_domain: 'rahulkul.udyami.ai',
    });

    const config = loadTenantConfig(filePath);
    expect(config.mla_name).toBe('Rahul Kul');
    expect(config.constituency).toBe('Daund');
    expect(config.complaint_id_prefix).toBe('RK');
    expect(config.wa_admin_group_jid).toBe('120363001234@g.us');
    expect(config.languages).toEqual(['mr', 'hi', 'en']);
    expect(config.daily_msg_limit).toBe(30);
    expect(config.office_phone).toBe('+912112345678');
    expect(config.office_address).toBe('123 Main St');
    expect(config.website_domain).toBe('rahulkul.udyami.ai');
  });

  it('throws validation error when mla_name is missing', () => {
    const filePath = writeTenantYaml({
      constituency: 'Daund',
      complaint_id_prefix: 'RK',
      wa_admin_group_jid: '',
      languages: ['mr'],
      office_phone: '',
    });

    expect(() => loadTenantConfig(filePath)).toThrow(/mla_name/i);
  });

  it('throws validation error when constituency is missing', () => {
    const filePath = writeTenantYaml({
      mla_name: 'Rahul Kul',
      complaint_id_prefix: 'RK',
      wa_admin_group_jid: '',
      languages: ['mr'],
      office_phone: '',
    });

    expect(() => loadTenantConfig(filePath)).toThrow(/constituency/i);
  });

  it('reads complaint_id_prefix correctly', () => {
    const filePath = writeTenantYaml({
      mla_name: 'Rahul Kul',
      constituency: 'Daund',
      complaint_id_prefix: 'DND',
      wa_admin_group_jid: '',
      languages: ['mr'],
      office_phone: '',
    });

    const config = loadTenantConfig(filePath);
    expect(config.complaint_id_prefix).toBe('DND');
  });

  it('applies default value for daily_msg_limit when not specified', () => {
    const filePath = writeTenantYaml({
      mla_name: 'Rahul Kul',
      constituency: 'Daund',
      complaint_id_prefix: 'RK',
      wa_admin_group_jid: '',
      languages: ['mr'],
      office_phone: '',
    });

    const config = loadTenantConfig(filePath);
    expect(config.daily_msg_limit).toBe(20);
  });

  it('applies default empty string for optional fields', () => {
    const filePath = writeTenantYaml({
      mla_name: 'Rahul Kul',
      constituency: 'Daund',
      complaint_id_prefix: 'RK',
      wa_admin_group_jid: '',
      languages: ['mr'],
      office_phone: '',
    });

    const config = loadTenantConfig(filePath);
    expect(config.office_address).toBe('');
    expect(config.website_domain).toBe('');
  });

  it('returns clear error for malformed YAML', () => {
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const filePath = path.join(configDir, 'tenant.yaml');
    fs.writeFileSync(filePath, '{ invalid yaml: [missing bracket', 'utf-8');

    expect(() => loadTenantConfig(filePath)).toThrow(/parse|yaml/i);
  });

  it('returns clear error when config file not found', () => {
    const missingPath = path.join(tmpDir, 'nonexistent', 'tenant.yaml');
    expect(() => loadTenantConfig(missingPath)).toThrow(/not found|ENOENT/i);
  });

  it('caches config on subsequent calls', () => {
    const filePath = writeTenantYaml({
      mla_name: 'Rahul Kul',
      constituency: 'Daund',
      complaint_id_prefix: 'RK',
      wa_admin_group_jid: '',
      languages: ['mr'],
      office_phone: '',
    });

    const config1 = loadTenantConfig(filePath);
    const config2 = loadTenantConfig(filePath);
    expect(config1).toBe(config2); // same reference — cached
  });

  it('throws when complaint_id_prefix is missing', () => {
    const filePath = writeTenantYaml({
      mla_name: 'Rahul Kul',
      constituency: 'Daund',
      wa_admin_group_jid: '',
      languages: ['mr'],
      office_phone: '',
    });

    expect(() => loadTenantConfig(filePath)).toThrow(/complaint_id_prefix/i);
  });

  it('throws when languages is empty', () => {
    const filePath = writeTenantYaml({
      mla_name: 'Rahul Kul',
      constituency: 'Daund',
      complaint_id_prefix: 'RK',
      wa_admin_group_jid: '',
      languages: [],
      office_phone: '',
    });

    expect(() => loadTenantConfig(filePath)).toThrow(/languages/i);
  });
});

// --- Cache to SQLite ---

describe('cacheTenantConfigToDb', () => {
  it('stores config values in tenant_config table', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tenant_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const config: TenantConfig = {
      mla_name: 'Rahul Kul',
      constituency: 'Daund',
      complaint_id_prefix: 'RK',
      wa_admin_group_jid: '120363001234@g.us',
      languages: ['mr', 'hi', 'en'],
      daily_msg_limit: 20,
      office_phone: '+912112345678',
      office_address: '123 Main St',
      website_domain: 'rahulkul.udyami.ai',
    };

    cacheTenantConfigToDb(db, config);

    const row = db.prepare('SELECT value FROM tenant_config WHERE key = ?').get('mla_name') as
      | { value: string }
      | undefined;
    expect(row?.value).toBe('Rahul Kul');

    const prefixRow = db
      .prepare('SELECT value FROM tenant_config WHERE key = ?')
      .get('complaint_id_prefix') as { value: string } | undefined;
    expect(prefixRow?.value).toBe('RK');

    const langRow = db.prepare('SELECT value FROM tenant_config WHERE key = ?').get('languages') as
      | { value: string }
      | undefined;
    expect(langRow?.value).toBe('mr,hi,en');

    const limitRow = db
      .prepare('SELECT value FROM tenant_config WHERE key = ?')
      .get('daily_msg_limit') as { value: string } | undefined;
    expect(limitRow?.value).toBe('20');
  });

  it('overwrites existing config values on re-cache', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tenant_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const config1: TenantConfig = {
      mla_name: 'Old Name',
      constituency: 'Old Place',
      complaint_id_prefix: 'OLD',
      wa_admin_group_jid: '',
      languages: ['en'],
      daily_msg_limit: 10,
      office_phone: '',
      office_address: '',
      website_domain: '',
    };

    cacheTenantConfigToDb(db, config1);

    const config2: TenantConfig = {
      mla_name: 'New Name',
      constituency: 'New Place',
      complaint_id_prefix: 'NEW',
      wa_admin_group_jid: '',
      languages: ['mr', 'hi'],
      daily_msg_limit: 30,
      office_phone: '',
      office_address: '',
      website_domain: '',
    };

    cacheTenantConfigToDb(db, config2);

    const row = db.prepare('SELECT value FROM tenant_config WHERE key = ?').get('mla_name') as
      | { value: string }
      | undefined;
    expect(row?.value).toBe('New Name');
  });
});

// --- Template variable injection ---

describe('injectTemplateVariables', () => {
  it('replaces template variables in CLAUDE.md content', () => {
    const config: TenantConfig = {
      mla_name: 'Rahul Kul',
      constituency: 'Daund',
      complaint_id_prefix: 'RK',
      wa_admin_group_jid: '',
      languages: ['mr', 'hi', 'en'],
      daily_msg_limit: 20,
      office_phone: '+912112345678',
      office_address: '123 Main St, Daund',
      website_domain: 'rahulkul.udyami.ai',
    };

    const template = `You are a complaint assistant for {mla_name}'s office in {constituency}.
Call {office_phone} for help. Complaint prefix: {complaint_id_prefix}.
Visit {website_domain} for more info. Address: {office_address}.`;

    const result = injectTemplateVariables(template, config);

    expect(result).toContain('Rahul Kul');
    expect(result).toContain('Daund');
    expect(result).toContain('+912112345678');
    expect(result).toContain('RK');
    expect(result).toContain('rahulkul.udyami.ai');
    expect(result).toContain('123 Main St, Daund');
    expect(result).not.toContain('{mla_name}');
    expect(result).not.toContain('{constituency}');
    expect(result).not.toContain('{office_phone}');
    expect(result).not.toContain('{complaint_id_prefix}');
    expect(result).not.toContain('{website_domain}');
    expect(result).not.toContain('{office_address}');
  });

  it('handles multiple occurrences of the same variable', () => {
    const config: TenantConfig = {
      mla_name: 'Rahul Kul',
      constituency: 'Daund',
      complaint_id_prefix: 'RK',
      wa_admin_group_jid: '',
      languages: ['mr'],
      daily_msg_limit: 20,
      office_phone: '',
      office_address: '',
      website_domain: '',
    };

    const template = '{mla_name} is great. {mla_name} is the MLA.';
    const result = injectTemplateVariables(template, config);
    expect(result).toBe('Rahul Kul is great. Rahul Kul is the MLA.');
  });

  it('leaves unknown template variables unchanged', () => {
    const config: TenantConfig = {
      mla_name: 'Rahul Kul',
      constituency: 'Daund',
      complaint_id_prefix: 'RK',
      wa_admin_group_jid: '',
      languages: ['mr'],
      daily_msg_limit: 20,
      office_phone: '',
      office_address: '',
      website_domain: '',
    };

    const template = '{mla_name} and {unknown_var}';
    const result = injectTemplateVariables(template, config);
    expect(result).toBe('Rahul Kul and {unknown_var}');
  });
});
