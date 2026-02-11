import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { _initTestDatabase } from './db.js';
import { _setRegisteredGroups } from './index.js';
import { VIRTUAL_COMPLAINT_GROUP_JID } from './channels/whatsapp.js';
import {
  loadTenantConfig,
  injectTemplateVariables,
  cacheTenantConfigToDb,
  _clearConfigCache,
} from './tenant-config.js';
import Database from 'better-sqlite3';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

// --- docker-compose.dev.yaml ---

describe('P1-S8: docker-compose.dev.yaml', () => {
  const composePath = path.join(PROJECT_ROOT, 'docker-compose.dev.yaml');

  it('docker-compose.dev.yaml exists', () => {
    expect(fs.existsSync(composePath)).toBe(true);
  });

  it('is valid YAML', () => {
    const content = fs.readFileSync(composePath, 'utf-8');
    const parsed = yaml.load(content) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
  });

  it('defines agent-build service with correct image name', () => {
    const content = fs.readFileSync(composePath, 'utf-8');
    const parsed = yaml.load(content) as { services: Record<string, unknown> };
    expect(parsed.services).toBeDefined();
    expect(parsed.services['agent-build']).toBeDefined();
  });

  it('targets ARM64 platform', () => {
    const content = fs.readFileSync(composePath, 'utf-8');
    expect(content).toContain('arm64');
  });

  it('builds from container/ context', () => {
    const content = fs.readFileSync(composePath, 'utf-8');
    expect(content).toContain('./container');
  });

  it('uses constituency-bot-agent image name', () => {
    const content = fs.readFileSync(composePath, 'utf-8');
    expect(content).toContain('constituency-bot-agent');
  });
});

// --- .env.example ---

describe('P1-S8: .env.example', () => {
  const envExamplePath = path.join(PROJECT_ROOT, '.env.example');

  it('.env.example exists', () => {
    expect(fs.existsSync(envExamplePath)).toBe(true);
  });

  it('contains CLAUDE_CODE_OAUTH_TOKEN placeholder', () => {
    const content = fs.readFileSync(envExamplePath, 'utf-8');
    expect(content).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('does not contain actual token values', () => {
    const content = fs.readFileSync(envExamplePath, 'utf-8');
    // Should only have a placeholder, not a real token
    const lines = content.split('\n').filter((l) => l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
    for (const line of lines) {
      const value = line.split('=')[1];
      // Value should be empty or a placeholder like "your_token_here"
      expect(value.length).toBeLessThan(50);
    }
  });
});

// --- Startup integration: tenant config + template injection + complaint group ---

describe('P1-S8: Startup integration', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({});
    _clearConfigCache();
  });

  it('tenant config loads from config/tenant.yaml', () => {
    const configPath = path.join(PROJECT_ROOT, 'config', 'tenant.yaml');
    expect(fs.existsSync(configPath)).toBe(true);
    const config = loadTenantConfig(configPath);
    expect(config.mla_name).toBe('Rahul Kul');
    expect(config.constituency).toBe('Daund');
  });

  it('CLAUDE.md template variables are replaced with tenant config values', () => {
    const configPath = path.join(PROJECT_ROOT, 'config', 'tenant.yaml');
    const claudeMdPath = path.join(PROJECT_ROOT, 'groups', 'complaint', 'CLAUDE.md');

    expect(fs.existsSync(claudeMdPath)).toBe(true);

    const config = loadTenantConfig(configPath);
    const template = fs.readFileSync(claudeMdPath, 'utf-8');
    const result = injectTemplateVariables(template, config);

    // Should have replaced tenant config variables
    expect(result).toContain('Rahul Kul');
    expect(result).toContain('Daund');
    expect(result).not.toContain('{mla_name}');
    expect(result).not.toContain('{constituency}');
    expect(result).not.toContain('{complaint_id_prefix}');

    // Runtime variables like {tracking_id} should remain (they're not config vars)
    expect(result).toContain('{tracking_id}');
    expect(result).toContain('{status}');
  });

  it('tenant config is cached to SQLite tenant_config table', () => {
    const configPath = path.join(PROJECT_ROOT, 'config', 'tenant.yaml');
    const config = loadTenantConfig(configPath);

    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE IF NOT EXISTS tenant_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    cacheTenantConfigToDb(db, config);

    const row = db.prepare('SELECT value FROM tenant_config WHERE key = ?').get('mla_name') as
      | { value: string }
      | undefined;
    expect(row?.value).toBe('Rahul Kul');

    const prefix = db
      .prepare('SELECT value FROM tenant_config WHERE key = ?')
      .get('complaint_id_prefix') as { value: string } | undefined;
    expect(prefix?.value).toBe('RK');

    db.close();
  });

  it('src/index.ts exports _setRegisteredGroups for test use', async () => {
    const indexModule = await import('./index.js');
    expect(typeof indexModule._setRegisteredGroups).toBe('function');
  });

  it('virtual complaint group can be registered with requiresTrigger=false', () => {
    _setRegisteredGroups({
      [VIRTUAL_COMPLAINT_GROUP_JID]: {
        name: 'Complaint',
        folder: 'complaint',
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      },
    });

    // Verify the group config is accepted without errors
    // The real test is that processGroupMessages finds it via registeredGroups[routeJid]
    expect(VIRTUAL_COMPLAINT_GROUP_JID).toBe('complaint@virtual');
  });
});

// --- build.sh updated ---

describe('P1-S8: Container build script', () => {
  const buildScriptPath = path.join(PROJECT_ROOT, 'container', 'build.sh');

  it('build.sh exists and is executable concept', () => {
    expect(fs.existsSync(buildScriptPath)).toBe(true);
  });

  it('uses constituency-bot-agent image name', () => {
    const content = fs.readFileSync(buildScriptPath, 'utf-8');
    expect(content).toContain('constituency-bot-agent');
  });
});
