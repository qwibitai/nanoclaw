import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPathRemap, recordPathRemap, resolvePathRemap } from '../path-remap.js';
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
  });
});
