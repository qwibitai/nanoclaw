import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isGitRepo, mergeFile } from '../merge.js';
import { createTempDir, initGitRepo, cleanup } from './test-helpers.js';

describe('merge', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  it('isGitRepo returns true in a git repo', () => {
    initGitRepo(tmpDir);
    expect(isGitRepo()).toBe(true);
  });

  it('isGitRepo returns false outside a git repo', () => {
    expect(isGitRepo()).toBe(false);
  });

  describe('mergeFile', () => {
    beforeEach(() => {
      initGitRepo(tmpDir);
    });

    it('clean merge with no overlapping changes', () => {
      const base = path.join(tmpDir, 'base.txt');
      const current = path.join(tmpDir, 'current.txt');
      const skill = path.join(tmpDir, 'skill.txt');

      fs.writeFileSync(base, 'line1\nline2\nline3\n');
      fs.writeFileSync(current, 'line1-modified\nline2\nline3\n');
      fs.writeFileSync(skill, 'line1\nline2\nline3-modified\n');

      const result = mergeFile(current, base, skill);
      expect(result.clean).toBe(true);
      expect(result.exitCode).toBe(0);

      const merged = fs.readFileSync(current, 'utf-8');
      expect(merged).toContain('line1-modified');
      expect(merged).toContain('line3-modified');
    });

    it('conflict with overlapping changes', () => {
      const base = path.join(tmpDir, 'base.txt');
      const current = path.join(tmpDir, 'current.txt');
      const skill = path.join(tmpDir, 'skill.txt');

      fs.writeFileSync(base, 'line1\nline2\nline3\n');
      fs.writeFileSync(current, 'line1-ours\nline2\nline3\n');
      fs.writeFileSync(skill, 'line1-theirs\nline2\nline3\n');

      const result = mergeFile(current, base, skill);
      expect(result.clean).toBe(false);
      expect(result.exitCode).toBeGreaterThan(0);

      const merged = fs.readFileSync(current, 'utf-8');
      expect(merged).toContain('<<<<<<<');
      expect(merged).toContain('>>>>>>>');
    });
  });
});
