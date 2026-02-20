import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { parse, stringify } from 'yaml';
import {
  findResolutionDir,
  loadResolutions,
  saveResolution,
} from '../resolution-cache.js';
import { createTempDir, setupNanoclawDir, initGitRepo, cleanup } from './test-helpers.js';

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

const dummyHashes = { base: 'aaa', current: 'bbb', skill: 'ccc' };

describe('resolution-cache', () => {
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

  it('findResolutionDir returns null when not found', () => {
    const result = findResolutionDir(['skill-a', 'skill-b'], tmpDir);
    expect(result).toBeNull();
  });

  it('saveResolution creates directory structure with files and meta', () => {
    saveResolution(
      ['skill-b', 'skill-a'],
      [{ relPath: 'src/config.ts', preimage: 'conflict content', resolution: 'resolved content', inputHashes: dummyHashes }],
      { core_version: '1.0.0' },
      tmpDir,
    );

    // Skills are sorted, so key is "skill-a+skill-b"
    const resDir = path.join(tmpDir, '.nanoclaw', 'resolutions', 'skill-a+skill-b');
    expect(fs.existsSync(resDir)).toBe(true);

    // Check preimage and resolution files exist
    expect(fs.existsSync(path.join(resDir, 'src/config.ts.preimage'))).toBe(true);
    expect(fs.existsSync(path.join(resDir, 'src/config.ts.resolution'))).toBe(true);

    // Check meta.yaml exists and has expected fields
    const metaPath = path.join(resDir, 'meta.yaml');
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.core_version).toBe('1.0.0');
    expect(meta.skills).toEqual(['skill-a', 'skill-b']);
  });

  it('saveResolution writes file_hashes to meta.yaml', () => {
    const hashes = {
      base: sha256('base content'),
      current: sha256('current content'),
      skill: sha256('skill content'),
    };

    saveResolution(
      ['alpha', 'beta'],
      [{ relPath: 'src/config.ts', preimage: 'pre', resolution: 'post', inputHashes: hashes }],
      {},
      tmpDir,
    );

    const resDir = path.join(tmpDir, '.nanoclaw', 'resolutions', 'alpha+beta');
    const meta = parse(fs.readFileSync(path.join(resDir, 'meta.yaml'), 'utf-8'));
    expect(meta.file_hashes).toBeDefined();
    expect(meta.file_hashes['src/config.ts']).toEqual(hashes);
  });

  it('findResolutionDir returns path after save', () => {
    saveResolution(
      ['alpha', 'beta'],
      [{ relPath: 'file.ts', preimage: 'pre', resolution: 'post', inputHashes: dummyHashes }],
      {},
      tmpDir,
    );

    const result = findResolutionDir(['alpha', 'beta'], tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('alpha+beta');
  });

  it('findResolutionDir finds shipped resolutions in .claude/resolutions', () => {
    const shippedDir = path.join(tmpDir, '.claude', 'resolutions', 'alpha+beta');
    fs.mkdirSync(shippedDir, { recursive: true });
    fs.writeFileSync(path.join(shippedDir, 'meta.yaml'), 'skills: [alpha, beta]\n');

    const result = findResolutionDir(['alpha', 'beta'], tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('.claude/resolutions/alpha+beta');
  });

  it('findResolutionDir prefers shipped over project-level', () => {
    // Create both shipped and project-level
    const shippedDir = path.join(tmpDir, '.claude', 'resolutions', 'a+b');
    fs.mkdirSync(shippedDir, { recursive: true });
    fs.writeFileSync(path.join(shippedDir, 'meta.yaml'), 'skills: [a, b]\n');

    saveResolution(
      ['a', 'b'],
      [{ relPath: 'f.ts', preimage: 'x', resolution: 'project', inputHashes: dummyHashes }],
      {},
      tmpDir,
    );

    const result = findResolutionDir(['a', 'b'], tmpDir);
    expect(result).toContain('.claude/resolutions/a+b');
  });

  it('skills are sorted so order does not matter', () => {
    saveResolution(
      ['zeta', 'alpha'],
      [{ relPath: 'f.ts', preimage: 'a', resolution: 'b', inputHashes: dummyHashes }],
      {},
      tmpDir,
    );

    // Find with reversed order should still work
    const result = findResolutionDir(['alpha', 'zeta'], tmpDir);
    expect(result).not.toBeNull();

    // Also works with original order
    const result2 = findResolutionDir(['zeta', 'alpha'], tmpDir);
    expect(result2).not.toBeNull();
    expect(result).toBe(result2);
  });

  describe('loadResolutions hash verification', () => {
    const baseContent = 'base file content';
    const currentContent = 'current file content';
    const skillContent = 'skill file content';
    const preimageContent = 'preimage with conflict markers';
    const resolutionContent = 'resolved content';
    const rerereHash = 'abc123def456';

    function setupResolutionDir(fileHashes: Record<string, any>) {
      // Create a shipped resolution directory
      const resDir = path.join(tmpDir, '.claude', 'resolutions', 'alpha+beta');
      fs.mkdirSync(path.join(resDir, 'src'), { recursive: true });

      // Write preimage, resolution, and hash sidecar
      fs.writeFileSync(path.join(resDir, 'src/config.ts.preimage'), preimageContent);
      fs.writeFileSync(path.join(resDir, 'src/config.ts.resolution'), resolutionContent);
      fs.writeFileSync(path.join(resDir, 'src/config.ts.preimage.hash'), rerereHash);

      // Write meta.yaml
      const meta: any = {
        skills: ['alpha', 'beta'],
        apply_order: ['alpha', 'beta'],
        core_version: '1.0.0',
        resolved_at: new Date().toISOString(),
        tested: true,
        test_passed: true,
        resolution_source: 'maintainer',
        input_hashes: {},
        output_hash: '',
        file_hashes: fileHashes,
      };
      fs.writeFileSync(path.join(resDir, 'meta.yaml'), stringify(meta));

      return resDir;
    }

    function setupInputFiles() {
      // Create base file
      fs.mkdirSync(path.join(tmpDir, '.nanoclaw', 'base', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.nanoclaw', 'base', 'src', 'config.ts'), baseContent);

      // Create current file
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'config.ts'), currentContent);
    }

    function createSkillDir() {
      const skillDir = path.join(tmpDir, 'skill-pkg');
      fs.mkdirSync(path.join(skillDir, 'modify', 'src'), { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'modify', 'src', 'config.ts'), skillContent);
      return skillDir;
    }

    beforeEach(() => {
      initGitRepo(tmpDir);
    });

    it('loads with matching file_hashes', () => {
      setupInputFiles();
      const skillDir = createSkillDir();

      setupResolutionDir({
        'src/config.ts': {
          base: sha256(baseContent),
          current: sha256(currentContent),
          skill: sha256(skillContent),
        },
      });

      const result = loadResolutions(['alpha', 'beta'], tmpDir, skillDir);
      expect(result).toBe(true);

      // Verify rr-cache entry was created
      const gitDir = path.join(tmpDir, '.git');
      const cacheEntry = path.join(gitDir, 'rr-cache', rerereHash);
      expect(fs.existsSync(path.join(cacheEntry, 'preimage'))).toBe(true);
      expect(fs.existsSync(path.join(cacheEntry, 'postimage'))).toBe(true);
    });

    it('skips pair with mismatched base hash', () => {
      setupInputFiles();
      const skillDir = createSkillDir();

      setupResolutionDir({
        'src/config.ts': {
          base: 'wrong_hash',
          current: sha256(currentContent),
          skill: sha256(skillContent),
        },
      });

      const result = loadResolutions(['alpha', 'beta'], tmpDir, skillDir);
      expect(result).toBe(false);

      // rr-cache entry should NOT be created
      const gitDir = path.join(tmpDir, '.git');
      expect(fs.existsSync(path.join(gitDir, 'rr-cache', rerereHash))).toBe(false);
    });

    it('skips pair with mismatched current hash', () => {
      setupInputFiles();
      const skillDir = createSkillDir();

      setupResolutionDir({
        'src/config.ts': {
          base: sha256(baseContent),
          current: 'wrong_hash',
          skill: sha256(skillContent),
        },
      });

      const result = loadResolutions(['alpha', 'beta'], tmpDir, skillDir);
      expect(result).toBe(false);
    });

    it('skips pair with mismatched skill hash', () => {
      setupInputFiles();
      const skillDir = createSkillDir();

      setupResolutionDir({
        'src/config.ts': {
          base: sha256(baseContent),
          current: sha256(currentContent),
          skill: 'wrong_hash',
        },
      });

      const result = loadResolutions(['alpha', 'beta'], tmpDir, skillDir);
      expect(result).toBe(false);
    });

    it('skips pair with no file_hashes entry for that file', () => {
      setupInputFiles();
      const skillDir = createSkillDir();

      // file_hashes exists but doesn't include src/config.ts
      setupResolutionDir({});

      const result = loadResolutions(['alpha', 'beta'], tmpDir, skillDir);
      expect(result).toBe(false);
    });
  });
});
