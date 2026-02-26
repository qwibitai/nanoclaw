import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadPathRemap,
  recordPathRemap,
  resolvePathRemap,
} from '../path-remap.js';
import { readState, writeState } from '../state.js';
import {
  cleanup,
  createMinimalState,
  createTempDir,
  setupNanoclawDir,
} from './test-helpers.js';

describe('path-remap', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    setupNanoclawDir(tmpDir);
    createMinimalState(tmpDir);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  describe('resolvePathRemap', () => {
    it('returns remapped path when entry exists', () => {
      const remap = { 'src/old.ts': 'src/new.ts' };
      expect(resolvePathRemap('src/old.ts', remap)).toBe('src/new.ts');
    });

    it('returns original path when no remap entry', () => {
      const remap = { 'src/old.ts': 'src/new.ts' };
      expect(resolvePathRemap('src/other.ts', remap)).toBe('src/other.ts');
    });

    it('returns original path when remap is empty', () => {
      expect(resolvePathRemap('src/file.ts', {})).toBe('src/file.ts');
    });

    it('ignores remap entries that escape project root', () => {
      const remap = { 'src/file.ts': '../../outside.txt' };
      expect(resolvePathRemap('src/file.ts', remap)).toBe('src/file.ts');
    });

    it('ignores remap target that resolves through symlink outside project root', () => {
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
        const remap = { 'src/file.ts': 'link-out/pwned.txt' };
        expect(resolvePathRemap('src/file.ts', remap)).toBe('src/file.ts');
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('throws when requested path itself escapes project root', () => {
      expect(() => resolvePathRemap('../../outside.txt', {})).toThrow(
        /escapes project root/i,
      );
    });
  });

  describe('loadPathRemap', () => {
    it('returns empty object when no remap in state', () => {
      const remap = loadPathRemap();
      expect(remap).toEqual({});
    });

    it('returns remap from state', () => {
      recordPathRemap({ 'src/a.ts': 'src/b.ts' });
      const remap = loadPathRemap();
      expect(remap).toEqual({ 'src/a.ts': 'src/b.ts' });
    });

    it('drops unsafe remap entries stored in state', () => {
      const state = readState();
      state.path_remap = {
        'src/a.ts': 'src/b.ts',
        'src/evil.ts': '../../outside.txt',
      };
      writeState(state);

      const remap = loadPathRemap();
      expect(remap).toEqual({ 'src/a.ts': 'src/b.ts' });
    });

    it('drops symlink-based escape entries stored in state', () => {
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
        state.path_remap = {
          'src/a.ts': 'src/b.ts',
          'src/evil.ts': 'link-out/pwned.txt',
        };
        writeState(state);

        const remap = loadPathRemap();
        expect(remap).toEqual({ 'src/a.ts': 'src/b.ts' });
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('recordPathRemap', () => {
    it('records new remap entries', () => {
      recordPathRemap({ 'src/old.ts': 'src/new.ts' });
      expect(loadPathRemap()).toEqual({ 'src/old.ts': 'src/new.ts' });
    });

    it('merges with existing remap', () => {
      recordPathRemap({ 'src/a.ts': 'src/b.ts' });
      recordPathRemap({ 'src/c.ts': 'src/d.ts' });
      expect(loadPathRemap()).toEqual({
        'src/a.ts': 'src/b.ts',
        'src/c.ts': 'src/d.ts',
      });
    });

    it('overwrites existing key on conflict', () => {
      recordPathRemap({ 'src/a.ts': 'src/b.ts' });
      recordPathRemap({ 'src/a.ts': 'src/c.ts' });
      expect(loadPathRemap()).toEqual({ 'src/a.ts': 'src/c.ts' });
    });

    it('rejects unsafe remap entries', () => {
      expect(() =>
        recordPathRemap({ 'src/a.ts': '../../outside.txt' }),
      ).toThrow(/escapes project root/i);
    });
  });
});
