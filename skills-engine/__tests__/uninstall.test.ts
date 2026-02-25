import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { uninstallSkill } from '../uninstall.js';
import {
  cleanup,
  createTempDir,
  initGitRepo,
  setupNanoclawDir,
  writeState,
} from './test-helpers.js';

describe('uninstall', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    setupNanoclawDir(tmpDir);
    initGitRepo(tmpDir);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  function setupSkillPackage(
    name: string,
    opts: {
      adds?: Record<string, string>;
      modifies?: Record<string, string>;
      modifiesBase?: Record<string, string>;
    } = {},
  ): void {
    const skillDir = path.join(tmpDir, '.claude', 'skills', name);
    fs.mkdirSync(skillDir, { recursive: true });

    const addsList = Object.keys(opts.adds ?? {});
    const modifiesList = Object.keys(opts.modifies ?? {});

    fs.writeFileSync(
      path.join(skillDir, 'manifest.yaml'),
      stringify({
        skill: name,
        version: '1.0.0',
        core_version: '1.0.0',
        adds: addsList,
        modifies: modifiesList,
      }),
    );

    if (opts.adds) {
      const addDir = path.join(skillDir, 'add');
      for (const [relPath, content] of Object.entries(opts.adds)) {
        const fullPath = path.join(addDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
      }
    }

    if (opts.modifies) {
      const modDir = path.join(skillDir, 'modify');
      for (const [relPath, content] of Object.entries(opts.modifies)) {
        const fullPath = path.join(modDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
      }
    }
  }

  it('returns error for non-applied skill', async () => {
    writeState(tmpDir, {
      skills_system_version: '0.1.0',
      core_version: '1.0.0',
      applied_skills: [],
    });

    const result = await uninstallSkill('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not applied');
  });

  it('blocks uninstall after rebase', async () => {
    writeState(tmpDir, {
      skills_system_version: '0.1.0',
      core_version: '1.0.0',
      rebased_at: new Date().toISOString(),
      applied_skills: [
        {
          name: 'telegram',
          version: '1.0.0',
          applied_at: new Date().toISOString(),
          file_hashes: { 'src/config.ts': 'abc' },
        },
      ],
    });

    const result = await uninstallSkill('telegram');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot uninstall');
    expect(result.error).toContain('after rebase');
  });

  it('returns custom patch warning', async () => {
    writeState(tmpDir, {
      skills_system_version: '0.1.0',
      core_version: '1.0.0',
      applied_skills: [
        {
          name: 'telegram',
          version: '1.0.0',
          applied_at: new Date().toISOString(),
          file_hashes: {},
          custom_patch: '.nanoclaw/custom/001.patch',
          custom_patch_description: 'My tweak',
        },
      ],
    });

    const result = await uninstallSkill('telegram');
    expect(result.success).toBe(false);
    expect(result.customPatchWarning).toContain('custom patch');
    expect(result.customPatchWarning).toContain('My tweak');
  });

  it('uninstalls only skill → files reset to base', async () => {
    // Set up base
    const baseDir = path.join(tmpDir, '.nanoclaw', 'base', 'src');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'config.ts'), 'base config\n');

    // Set up current files (as if skill was applied)
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'config.ts'),
      'base config\ntelegram config\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'telegram.ts'),
      'telegram code\n',
    );

    // Set up skill package in .claude/skills/
    setupSkillPackage('telegram', {
      adds: { 'src/telegram.ts': 'telegram code\n' },
      modifies: {
        'src/config.ts': 'base config\ntelegram config\n',
      },
    });

    writeState(tmpDir, {
      skills_system_version: '0.1.0',
      core_version: '1.0.0',
      applied_skills: [
        {
          name: 'telegram',
          version: '1.0.0',
          applied_at: new Date().toISOString(),
          file_hashes: {
            'src/config.ts': 'abc',
            'src/telegram.ts': 'def',
          },
        },
      ],
    });

    const result = await uninstallSkill('telegram');
    expect(result.success).toBe(true);
    expect(result.skill).toBe('telegram');

    // config.ts should be reset to base
    expect(
      fs.readFileSync(path.join(tmpDir, 'src', 'config.ts'), 'utf-8'),
    ).toBe('base config\n');

    // telegram.ts (add-only) should be removed
    expect(fs.existsSync(path.join(tmpDir, 'src', 'telegram.ts'))).toBe(false);
  });

  it('uninstalls one of two → other preserved', async () => {
    // Set up base
    const baseDir = path.join(tmpDir, '.nanoclaw', 'base', 'src');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(
      path.join(baseDir, 'config.ts'),
      'line1\nline2\nline3\nline4\nline5\n',
    );

    // Current has both skills applied
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'config.ts'),
      'telegram import\nline1\nline2\nline3\nline4\nline5\ndiscord import\n',
    );
    fs.writeFileSync(path.join(tmpDir, 'src', 'telegram.ts'), 'tg code\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'discord.ts'), 'dc code\n');

    // Set up both skill packages
    setupSkillPackage('telegram', {
      adds: { 'src/telegram.ts': 'tg code\n' },
      modifies: {
        'src/config.ts': 'telegram import\nline1\nline2\nline3\nline4\nline5\n',
      },
    });

    setupSkillPackage('discord', {
      adds: { 'src/discord.ts': 'dc code\n' },
      modifies: {
        'src/config.ts': 'line1\nline2\nline3\nline4\nline5\ndiscord import\n',
      },
    });

    writeState(tmpDir, {
      skills_system_version: '0.1.0',
      core_version: '1.0.0',
      applied_skills: [
        {
          name: 'telegram',
          version: '1.0.0',
          applied_at: new Date().toISOString(),
          file_hashes: {
            'src/config.ts': 'abc',
            'src/telegram.ts': 'def',
          },
        },
        {
          name: 'discord',
          version: '1.0.0',
          applied_at: new Date().toISOString(),
          file_hashes: {
            'src/config.ts': 'ghi',
            'src/discord.ts': 'jkl',
          },
        },
      ],
    });

    const result = await uninstallSkill('telegram');
    expect(result.success).toBe(true);

    // discord.ts should still exist
    expect(fs.existsSync(path.join(tmpDir, 'src', 'discord.ts'))).toBe(true);

    // telegram.ts should be gone
    expect(fs.existsSync(path.join(tmpDir, 'src', 'telegram.ts'))).toBe(false);

    // config should have discord import but not telegram
    const config = fs.readFileSync(
      path.join(tmpDir, 'src', 'config.ts'),
      'utf-8',
    );
    expect(config).toContain('discord import');
    expect(config).not.toContain('telegram import');
  });
});
