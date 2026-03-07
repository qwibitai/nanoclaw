import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applySkill } from '../apply.js';
import {
  cleanup,
  createMinimalState,
  createSkillPackage,
  createTempDir,
  initGitRepo,
  setupNanoclawDir,
} from './test-helpers.js';
import { readState, writeState } from '../state.js';

describe('apply', () => {
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

  it('rejects when min_skills_system_version is too high', async () => {
    const skillDir = createSkillPackage(tmpDir, {
      skill: 'future-skill',
      version: '1.0.0',
      core_version: '1.0.0',
      adds: [],
      modifies: [],
      min_skills_system_version: '99.0.0',
    });

    const result = await applySkill(skillDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('99.0.0');
  });

  it('executes post_apply commands on success', async () => {
    const markerFile = path.join(tmpDir, 'post-apply-marker.txt');
    const skillDir = createSkillPackage(tmpDir, {
      skill: 'post-test',
      version: '1.0.0',
      core_version: '1.0.0',
      adds: ['src/newfile.ts'],
      modifies: [],
      addFiles: { 'src/newfile.ts': 'export const x = 1;' },
      post_apply: [`echo "applied" > "${markerFile}"`],
    });

    const result = await applySkill(skillDir);
    expect(result.success).toBe(true);
    expect(fs.existsSync(markerFile)).toBe(true);
    expect(fs.readFileSync(markerFile, 'utf-8').trim()).toBe('applied');
  });

  it('rolls back on post_apply failure', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const existingFile = path.join(tmpDir, 'src/existing.ts');
    fs.writeFileSync(existingFile, 'original content');

    // Set up base for the modified file
    const baseDir = path.join(tmpDir, '.nanoclaw', 'base', 'src');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'existing.ts'), 'original content');

    const skillDir = createSkillPackage(tmpDir, {
      skill: 'bad-post',
      version: '1.0.0',
      core_version: '1.0.0',
      adds: ['src/added.ts'],
      modifies: [],
      addFiles: { 'src/added.ts': 'new file' },
      post_apply: ['false'], // always fails
    });

    const result = await applySkill(skillDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('post_apply');

    // Added file should be cleaned up
    expect(fs.existsSync(path.join(tmpDir, 'src/added.ts'))).toBe(false);
  });

  it('does not allow path_remap to write files outside project root', async () => {
    const state = readState();
    state.path_remap = { 'src/newfile.ts': '../../outside.txt' };
    writeState(state);

    const skillDir = createSkillPackage(tmpDir, {
      skill: 'remap-escape',
      version: '1.0.0',
      core_version: '1.0.0',
      adds: ['src/newfile.ts'],
      modifies: [],
      addFiles: { 'src/newfile.ts': 'safe content' },
    });

    const result = await applySkill(skillDir);
    expect(result.success).toBe(true);

    // Remap escape is ignored; file remains constrained inside project root.
    expect(fs.existsSync(path.join(tmpDir, 'src/newfile.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '..', 'outside.txt'))).toBe(false);
  });

  it('does not allow path_remap symlink targets to write outside project root', async () => {
    const outsideDir = fs.mkdtempSync(
      path.join(path.dirname(tmpDir), 'nanoclaw-remap-outside-'),
    );
    const linkPath = path.join(tmpDir, 'link-out');

    try {
      fs.symlinkSync(outsideDir, linkPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        fs.rmSync(outsideDir, { recursive: true, force: true });
        return;
      }
      fs.rmSync(outsideDir, { recursive: true, force: true });
      throw err;
    }

    try {
      const state = readState();
      state.path_remap = { 'src/newfile.ts': 'link-out/pwned.txt' };
      writeState(state);

      const skillDir = createSkillPackage(tmpDir, {
        skill: 'remap-symlink-escape',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: ['src/newfile.ts'],
        modifies: [],
        addFiles: { 'src/newfile.ts': 'safe content' },
      });

      const result = await applySkill(skillDir);
      expect(result.success).toBe(true);

      expect(fs.existsSync(path.join(tmpDir, 'src/newfile.ts'))).toBe(true);
      expect(fs.existsSync(path.join(outsideDir, 'pwned.txt'))).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
