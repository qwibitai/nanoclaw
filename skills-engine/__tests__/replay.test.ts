import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findSkillDir, replaySkills } from '../replay.js';
import {
  cleanup,
  createMinimalState,
  createSkillPackage,
  createTempDir,
  initGitRepo,
  setupNanoclawDir,
} from './test-helpers.js';

describe('replay', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    setupNanoclawDir(tmpDir);
    createMinimalState(tmpDir);
    initGitRepo(tmpDir);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  describe('findSkillDir', () => {
    it('finds skill directory by name', () => {
      const skillsRoot = path.join(tmpDir, '.claude', 'skills', 'telegram');
      fs.mkdirSync(skillsRoot, { recursive: true });
      const { stringify } = require('yaml');
      fs.writeFileSync(
        path.join(skillsRoot, 'manifest.yaml'),
        stringify({
          skill: 'telegram',
          version: '1.0.0',
          core_version: '1.0.0',
          adds: [],
          modifies: [],
        }),
      );

      const result = findSkillDir('telegram', tmpDir);
      expect(result).toBe(skillsRoot);
    });

    it('returns null for missing skill', () => {
      const result = findSkillDir('nonexistent', tmpDir);
      expect(result).toBeNull();
    });

    it('returns null when .claude/skills does not exist', () => {
      const result = findSkillDir('anything', tmpDir);
      expect(result).toBeNull();
    });
  });

  describe('replaySkills', () => {
    it('replays a single skill from base', async () => {
      // Set up base file
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base', 'src');
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(path.join(baseDir, 'config.ts'), 'base content\n');

      // Set up current file (will be overwritten by replay)
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'config.ts'),
        'modified content\n',
      );

      // Create skill package
      const skillDir = createSkillPackage(tmpDir, {
        skill: 'telegram',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: ['src/telegram.ts'],
        modifies: ['src/config.ts'],
        addFiles: { 'src/telegram.ts': 'telegram code\n' },
        modifyFiles: { 'src/config.ts': 'base content\ntelegram config\n' },
      });

      const result = await replaySkills({
        skills: ['telegram'],
        skillDirs: { telegram: skillDir },
        projectRoot: tmpDir,
      });

      expect(result.success).toBe(true);
      expect(result.perSkill.telegram.success).toBe(true);

      // Added file should exist
      expect(fs.existsSync(path.join(tmpDir, 'src', 'telegram.ts'))).toBe(true);
      expect(
        fs.readFileSync(path.join(tmpDir, 'src', 'telegram.ts'), 'utf-8'),
      ).toBe('telegram code\n');

      // Modified file should be merged from base
      const config = fs.readFileSync(
        path.join(tmpDir, 'src', 'config.ts'),
        'utf-8',
      );
      expect(config).toContain('telegram config');
    });

    it('replays two skills in order', async () => {
      // Set up base
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base', 'src');
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(
        path.join(baseDir, 'config.ts'),
        'line1\nline2\nline3\nline4\nline5\n',
      );

      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'config.ts'),
        'line1\nline2\nline3\nline4\nline5\n',
      );

      // Skill 1 adds at top
      const skill1Dir = createSkillPackage(tmpDir, {
        skill: 'telegram',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: ['src/telegram.ts'],
        modifies: ['src/config.ts'],
        addFiles: { 'src/telegram.ts': 'tg code' },
        modifyFiles: {
          'src/config.ts':
            'telegram import\nline1\nline2\nline3\nline4\nline5\n',
        },
        dirName: 'skill-pkg-tg',
      });

      // Skill 2 adds at bottom
      const skill2Dir = createSkillPackage(tmpDir, {
        skill: 'discord',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: ['src/discord.ts'],
        modifies: ['src/config.ts'],
        addFiles: { 'src/discord.ts': 'dc code' },
        modifyFiles: {
          'src/config.ts':
            'line1\nline2\nline3\nline4\nline5\ndiscord import\n',
        },
        dirName: 'skill-pkg-dc',
      });

      const result = await replaySkills({
        skills: ['telegram', 'discord'],
        skillDirs: { telegram: skill1Dir, discord: skill2Dir },
        projectRoot: tmpDir,
      });

      expect(result.success).toBe(true);
      expect(result.perSkill.telegram.success).toBe(true);
      expect(result.perSkill.discord.success).toBe(true);

      // Both added files should exist
      expect(fs.existsSync(path.join(tmpDir, 'src', 'telegram.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'src', 'discord.ts'))).toBe(true);

      // Config should have both changes
      const config = fs.readFileSync(
        path.join(tmpDir, 'src', 'config.ts'),
        'utf-8',
      );
      expect(config).toContain('telegram import');
      expect(config).toContain('discord import');
    });

    it('stops on first conflict and does not process later skills', async () => {
      // After reset, current=base. Skill 1 merges cleanly (changes line 1).
      // Skill 2 also changes line 1 differently → conflict with skill 1's result.
      // Skill 3 should NOT be processed due to break-on-conflict.
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base', 'src');
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(path.join(baseDir, 'config.ts'), 'line1\n');

      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'config.ts'), 'line1\n');

      // Skill 1: changes line 1 — merges cleanly since current=base after reset
      const skill1Dir = createSkillPackage(tmpDir, {
        skill: 'skill-a',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: [],
        modifies: ['src/config.ts'],
        modifyFiles: { 'src/config.ts': 'line1-from-skill-a\n' },
        dirName: 'skill-pkg-a',
      });

      // Skill 2: also changes line 1 differently → conflict with skill-a's result
      const skill2Dir = createSkillPackage(tmpDir, {
        skill: 'skill-b',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: [],
        modifies: ['src/config.ts'],
        modifyFiles: { 'src/config.ts': 'line1-from-skill-b\n' },
        dirName: 'skill-pkg-b',
      });

      // Skill 3: adds a new file — should be skipped
      const skill3Dir = createSkillPackage(tmpDir, {
        skill: 'skill-c',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: ['src/newfile.ts'],
        modifies: [],
        addFiles: { 'src/newfile.ts': 'should not appear' },
        dirName: 'skill-pkg-c',
      });

      const result = await replaySkills({
        skills: ['skill-a', 'skill-b', 'skill-c'],
        skillDirs: {
          'skill-a': skill1Dir,
          'skill-b': skill2Dir,
          'skill-c': skill3Dir,
        },
        projectRoot: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.mergeConflicts).toBeDefined();
      expect(result.mergeConflicts!.length).toBeGreaterThan(0);
      // Skill B caused the conflict
      expect(result.perSkill['skill-b']?.success).toBe(false);
      // Skill C should NOT have been processed
      expect(result.perSkill['skill-c']).toBeUndefined();
    });

    it('returns error for missing skill dir', async () => {
      const result = await replaySkills({
        skills: ['missing'],
        skillDirs: {},
        projectRoot: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('missing');
      expect(result.perSkill.missing.success).toBe(false);
    });

    it('resets files to base before replay', async () => {
      // Set up base
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base', 'src');
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(path.join(baseDir, 'config.ts'), 'base content\n');

      // Current has drift
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'config.ts'),
        'drifted content\n',
      );

      // Also a stale added file
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'stale-add.ts'),
        'should be removed',
      );

      const skillDir = createSkillPackage(tmpDir, {
        skill: 'skill1',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: ['src/stale-add.ts'],
        modifies: ['src/config.ts'],
        addFiles: { 'src/stale-add.ts': 'fresh add' },
        modifyFiles: { 'src/config.ts': 'base content\nskill addition\n' },
      });

      const result = await replaySkills({
        skills: ['skill1'],
        skillDirs: { skill1: skillDir },
        projectRoot: tmpDir,
      });

      expect(result.success).toBe(true);

      // The added file should have the fresh content (not stale)
      expect(
        fs.readFileSync(path.join(tmpDir, 'src', 'stale-add.ts'), 'utf-8'),
      ).toBe('fresh add');
    });
  });
});
