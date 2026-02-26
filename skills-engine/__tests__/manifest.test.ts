import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { stringify } from 'yaml';
import {
  readManifest,
  checkCoreVersion,
  checkDependencies,
  checkConflicts,
  checkSystemVersion,
} from '../manifest.js';
import {
  createTempDir,
  setupNanoclawDir,
  createMinimalState,
  createSkillPackage,
  cleanup,
  writeState,
} from './test-helpers.js';
import { recordSkillApplication } from '../state.js';

describe('manifest', () => {
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

  it('parses a valid manifest', () => {
    const skillDir = createSkillPackage(tmpDir, {
      skill: 'telegram',
      version: '2.0.0',
      core_version: '1.0.0',
      adds: ['src/telegram.ts'],
      modifies: ['src/config.ts'],
    });
    const manifest = readManifest(skillDir);
    expect(manifest.skill).toBe('telegram');
    expect(manifest.version).toBe('2.0.0');
    expect(manifest.adds).toEqual(['src/telegram.ts']);
    expect(manifest.modifies).toEqual(['src/config.ts']);
  });

  it('throws on missing skill field', () => {
    const dir = path.join(tmpDir, 'bad-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.yaml'),
      stringify({
        version: '1.0.0',
        core_version: '1.0.0',
        adds: [],
        modifies: [],
      }),
    );
    expect(() => readManifest(dir)).toThrow();
  });

  it('throws on missing version field', () => {
    const dir = path.join(tmpDir, 'bad-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.yaml'),
      stringify({
        skill: 'test',
        core_version: '1.0.0',
        adds: [],
        modifies: [],
      }),
    );
    expect(() => readManifest(dir)).toThrow();
  });

  it('throws on missing core_version field', () => {
    const dir = path.join(tmpDir, 'bad-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.yaml'),
      stringify({
        skill: 'test',
        version: '1.0.0',
        adds: [],
        modifies: [],
      }),
    );
    expect(() => readManifest(dir)).toThrow();
  });

  it('throws on missing adds field', () => {
    const dir = path.join(tmpDir, 'bad-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.yaml'),
      stringify({
        skill: 'test',
        version: '1.0.0',
        core_version: '1.0.0',
        modifies: [],
      }),
    );
    expect(() => readManifest(dir)).toThrow();
  });

  it('throws on missing modifies field', () => {
    const dir = path.join(tmpDir, 'bad-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.yaml'),
      stringify({
        skill: 'test',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: [],
      }),
    );
    expect(() => readManifest(dir)).toThrow();
  });

  it('throws on path traversal in adds', () => {
    const dir = path.join(tmpDir, 'bad-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.yaml'),
      stringify({
        skill: 'test',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: ['../etc/passwd'],
        modifies: [],
      }),
    );
    expect(() => readManifest(dir)).toThrow('Invalid path');
  });

  it('throws on path traversal in modifies', () => {
    const dir = path.join(tmpDir, 'bad-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.yaml'),
      stringify({
        skill: 'test',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: [],
        modifies: ['../../secret.ts'],
      }),
    );
    expect(() => readManifest(dir)).toThrow('Invalid path');
  });

  it('throws on absolute path in adds', () => {
    const dir = path.join(tmpDir, 'bad-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.yaml'),
      stringify({
        skill: 'test',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: ['/etc/passwd'],
        modifies: [],
      }),
    );
    expect(() => readManifest(dir)).toThrow('Invalid path');
  });

  it('defaults conflicts and depends to empty arrays', () => {
    const skillDir = createSkillPackage(tmpDir, {
      skill: 'test',
      version: '1.0.0',
      core_version: '1.0.0',
      adds: [],
      modifies: [],
    });
    const manifest = readManifest(skillDir);
    expect(manifest.conflicts).toEqual([]);
    expect(manifest.depends).toEqual([]);
  });

  it('checkCoreVersion returns warning when manifest targets newer core', () => {
    const skillDir = createSkillPackage(tmpDir, {
      skill: 'test',
      version: '1.0.0',
      core_version: '2.0.0',
      adds: [],
      modifies: [],
    });
    const manifest = readManifest(skillDir);
    const result = checkCoreVersion(manifest);
    expect(result.warning).toBeTruthy();
  });

  it('checkCoreVersion returns no warning when versions match', () => {
    const skillDir = createSkillPackage(tmpDir, {
      skill: 'test',
      version: '1.0.0',
      core_version: '1.0.0',
      adds: [],
      modifies: [],
    });
    const manifest = readManifest(skillDir);
    const result = checkCoreVersion(manifest);
    expect(result.ok).toBe(true);
    expect(result.warning).toBeFalsy();
  });

  it('checkDependencies satisfied when deps present', () => {
    recordSkillApplication('dep-skill', '1.0.0', {});
    const skillDir = createSkillPackage(tmpDir, {
      skill: 'test',
      version: '1.0.0',
      core_version: '1.0.0',
      adds: [],
      modifies: [],
      depends: ['dep-skill'],
    });
    const manifest = readManifest(skillDir);
    const result = checkDependencies(manifest);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('checkDependencies missing when deps not present', () => {
    const skillDir = createSkillPackage(tmpDir, {
      skill: 'test',
      version: '1.0.0',
      core_version: '1.0.0',
      adds: [],
      modifies: [],
      depends: ['missing-skill'],
    });
    const manifest = readManifest(skillDir);
    const result = checkDependencies(manifest);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('missing-skill');
  });

  it('checkConflicts ok when no conflicts', () => {
    const skillDir = createSkillPackage(tmpDir, {
      skill: 'test',
      version: '1.0.0',
      core_version: '1.0.0',
      adds: [],
      modifies: [],
      conflicts: [],
    });
    const manifest = readManifest(skillDir);
    const result = checkConflicts(manifest);
    expect(result.ok).toBe(true);
    expect(result.conflicting).toEqual([]);
  });

  it('checkConflicts detects conflicting skill', () => {
    recordSkillApplication('bad-skill', '1.0.0', {});
    const skillDir = createSkillPackage(tmpDir, {
      skill: 'test',
      version: '1.0.0',
      core_version: '1.0.0',
      adds: [],
      modifies: [],
      conflicts: ['bad-skill'],
    });
    const manifest = readManifest(skillDir);
    const result = checkConflicts(manifest);
    expect(result.ok).toBe(false);
    expect(result.conflicting).toContain('bad-skill');
  });

  it('parses new optional fields (author, license, etc)', () => {
    const dir = path.join(tmpDir, 'full-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.yaml'),
      stringify({
        skill: 'test',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: [],
        modifies: [],
        author: 'tester',
        license: 'MIT',
        min_skills_system_version: '0.1.0',
        tested_with: ['telegram', 'discord'],
        post_apply: ['echo done'],
      }),
    );
    const manifest = readManifest(dir);
    expect(manifest.author).toBe('tester');
    expect(manifest.license).toBe('MIT');
    expect(manifest.min_skills_system_version).toBe('0.1.0');
    expect(manifest.tested_with).toEqual(['telegram', 'discord']);
    expect(manifest.post_apply).toEqual(['echo done']);
  });

  it('checkSystemVersion passes when not set', () => {
    const skillDir = createSkillPackage(tmpDir, {
      skill: 'test',
      version: '1.0.0',
      core_version: '1.0.0',
      adds: [],
      modifies: [],
    });
    const manifest = readManifest(skillDir);
    const result = checkSystemVersion(manifest);
    expect(result.ok).toBe(true);
  });

  it('checkSystemVersion passes when engine is new enough', () => {
    const dir = path.join(tmpDir, 'sys-ok');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.yaml'),
      stringify({
        skill: 'test',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: [],
        modifies: [],
        min_skills_system_version: '0.1.0',
      }),
    );
    const manifest = readManifest(dir);
    const result = checkSystemVersion(manifest);
    expect(result.ok).toBe(true);
  });

  it('checkSystemVersion fails when engine is too old', () => {
    const dir = path.join(tmpDir, 'sys-fail');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.yaml'),
      stringify({
        skill: 'test',
        version: '1.0.0',
        core_version: '1.0.0',
        adds: [],
        modifies: [],
        min_skills_system_version: '99.0.0',
      }),
    );
    const manifest = readManifest(dir);
    const result = checkSystemVersion(manifest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('99.0.0');
  });
});
