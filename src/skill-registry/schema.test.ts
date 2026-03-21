import { describe, it, expect } from 'vitest';

import {
  SkillMetadataSchema,
  SkillRegistrySchema,
  InstalledSkillsStateSchema,
} from './schema.js';

describe('SkillMetadataSchema', () => {
  const validSkill = {
    name: 'add-telegram',
    displayName: 'Telegram Channel',
    description: 'Add Telegram as a messaging channel for NanoClaw.',
    type: 'feature',
    installMethod: 'branch-merge',
    version: '1.0.0',
    author: 'qwibitai',
    tags: ['channel', 'telegram', 'messaging'],
    branch: 'skill/telegram',
    dependencies: [],
    triggers: ['/add-telegram'],
    updatedAt: '2026-03-20T00:00:00Z',
  };

  it('accepts valid skill metadata', () => {
    const result = SkillMetadataSchema.parse(validSkill);
    expect(result.name).toBe('add-telegram');
    expect(result.type).toBe('feature');
  });

  it('rejects invalid skill names', () => {
    expect(() =>
      SkillMetadataSchema.parse({ ...validSkill, name: 'Invalid Name!' }),
    ).toThrow();
  });

  it('rejects non-semver versions', () => {
    expect(() =>
      SkillMetadataSchema.parse({ ...validSkill, version: 'latest' }),
    ).toThrow();
  });

  it('rejects invalid skill types', () => {
    expect(() =>
      SkillMetadataSchema.parse({ ...validSkill, type: 'unknown' }),
    ).toThrow();
  });

  it('allows optional fields to be omitted', () => {
    const minimal = { ...validSkill };
    // These are optional
    delete (minimal as Record<string, unknown>).longDescription;
    delete (minimal as Record<string, unknown>).license;
    delete (minimal as Record<string, unknown>).remote;
    delete (minimal as Record<string, unknown>).docsUrl;
    delete (minimal as Record<string, unknown>).minVersion;

    const result = SkillMetadataSchema.parse(minimal);
    expect(result.name).toBe('add-telegram');
  });
});

describe('SkillRegistrySchema', () => {
  it('accepts a valid registry', () => {
    const registry = {
      schemaVersion: '1.0.0',
      generatedAt: '2026-03-20T00:00:00Z',
      skills: [
        {
          name: 'add-discord',
          displayName: 'Discord Channel',
          description: 'Add Discord as a messaging channel.',
          type: 'feature',
          installMethod: 'branch-merge',
          version: '1.0.0',
          author: 'qwibitai',
          tags: ['channel', 'discord'],
          branch: 'skill/discord',
          dependencies: [],
          triggers: ['/add-discord'],
          updatedAt: '2026-03-20T00:00:00Z',
        },
      ],
    };

    const result = SkillRegistrySchema.parse(registry);
    expect(result.skills).toHaveLength(1);
    expect(result.schemaVersion).toBe('1.0.0');
  });

  it('accepts an empty skills array', () => {
    const registry = {
      schemaVersion: '1.0.0',
      generatedAt: '2026-03-20T00:00:00Z',
      skills: [],
    };

    const result = SkillRegistrySchema.parse(registry);
    expect(result.skills).toHaveLength(0);
  });
});

describe('InstalledSkillsStateSchema', () => {
  it('accepts valid installed state', () => {
    const state = {
      version: '1.0.0',
      skills: {
        'add-telegram': {
          name: 'add-telegram',
          version: '1.0.0',
          installedAt: '2026-03-20T00:00:00Z',
          source: 'nanoclaw-skills',
          mergeCommit: 'abc123',
        },
      },
    };

    const result = InstalledSkillsStateSchema.parse(state);
    expect(Object.keys(result.skills)).toHaveLength(1);
  });

  it('accepts empty skills map', () => {
    const state = {
      version: '1.0.0',
      skills: {},
    };

    const result = InstalledSkillsStateSchema.parse(state);
    expect(Object.keys(result.skills)).toHaveLength(0);
  });
});
