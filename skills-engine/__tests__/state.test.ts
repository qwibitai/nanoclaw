import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  readState,
  writeState,
  recordSkillApplication,
  computeFileHash,
  compareSemver,
  recordCustomModification,
  getCustomModifications,
} from '../state.js';
import {
  createTempDir,
  setupNanoclawDir,
  createMinimalState,
  writeState as writeStateHelper,
  cleanup,
} from './test-helpers.js';

describe('state', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    setupNanoclawDir(tmpDir);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  it('readState/writeState roundtrip', () => {
    const state = {
      skills_system_version: '0.1.0',
      core_version: '1.0.0',
      applied_skills: [],
    };
    writeState(state);
    const result = readState();
    expect(result.skills_system_version).toBe('0.1.0');
    expect(result.core_version).toBe('1.0.0');
    expect(result.applied_skills).toEqual([]);
  });

  it('readState throws when no state file exists', () => {
    expect(() => readState()).toThrow();
  });

  it('readState throws when version is newer than current', () => {
    writeStateHelper(tmpDir, {
      skills_system_version: '99.0.0',
      core_version: '1.0.0',
      applied_skills: [],
    });
    expect(() => readState()).toThrow();
  });

  it('recordSkillApplication adds a skill', () => {
    createMinimalState(tmpDir);
    recordSkillApplication('my-skill', '1.0.0', { 'src/foo.ts': 'abc123' });
    const state = readState();
    expect(state.applied_skills).toHaveLength(1);
    expect(state.applied_skills[0].name).toBe('my-skill');
    expect(state.applied_skills[0].version).toBe('1.0.0');
    expect(state.applied_skills[0].file_hashes).toEqual({
      'src/foo.ts': 'abc123',
    });
  });

  it('re-applying same skill replaces it', () => {
    createMinimalState(tmpDir);
    recordSkillApplication('my-skill', '1.0.0', { 'a.ts': 'hash1' });
    recordSkillApplication('my-skill', '2.0.0', { 'a.ts': 'hash2' });
    const state = readState();
    expect(state.applied_skills).toHaveLength(1);
    expect(state.applied_skills[0].version).toBe('2.0.0');
    expect(state.applied_skills[0].file_hashes).toEqual({ 'a.ts': 'hash2' });
  });

  it('computeFileHash produces consistent sha256', () => {
    const filePath = path.join(tmpDir, 'hashtest.txt');
    fs.writeFileSync(filePath, 'hello world');
    const hash1 = computeFileHash(filePath);
    const hash2 = computeFileHash(filePath);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  describe('compareSemver', () => {
    it('1.0.0 < 1.1.0', () => {
      expect(compareSemver('1.0.0', '1.1.0')).toBeLessThan(0);
    });

    it('0.9.0 < 0.10.0', () => {
      expect(compareSemver('0.9.0', '0.10.0')).toBeLessThan(0);
    });

    it('1.0.0 = 1.0.0', () => {
      expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    });
  });

  it('recordCustomModification adds to array', () => {
    createMinimalState(tmpDir);
    recordCustomModification('tweak', ['src/a.ts'], 'custom/001-tweak.patch');
    const mods = getCustomModifications();
    expect(mods).toHaveLength(1);
    expect(mods[0].description).toBe('tweak');
    expect(mods[0].files_modified).toEqual(['src/a.ts']);
    expect(mods[0].patch_file).toBe('custom/001-tweak.patch');
  });

  it('getCustomModifications returns empty when none recorded', () => {
    createMinimalState(tmpDir);
    const mods = getCustomModifications();
    expect(mods).toEqual([]);
  });
});
