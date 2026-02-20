import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import { cleanup, createTempDir, initGitRepo, setupNanoclawDir } from './test-helpers.js';

// We need to mock process.cwd() since update.ts uses it
let tmpDir: string;

describe('update', () => {
  beforeEach(() => {
    tmpDir = createTempDir();
    setupNanoclawDir(tmpDir);
    initGitRepo(tmpDir);
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(tmpDir);
  });

  function writeStateFile(state: Record<string, unknown>): void {
    const statePath = path.join(tmpDir, '.nanoclaw', 'state.yaml');
    fs.writeFileSync(statePath, stringify(state), 'utf-8');
  }

  function createNewCoreDir(files: Record<string, string>): string {
    const newCoreDir = path.join(tmpDir, 'new-core');
    fs.mkdirSync(newCoreDir, { recursive: true });

    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = path.join(newCoreDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }

    return newCoreDir;
  }

  describe('previewUpdate', () => {
    it('detects new files in update', async () => {
      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      const newCoreDir = createNewCoreDir({
        'src/new-file.ts': 'export const x = 1;',
      });

      const { previewUpdate } = await import('../update.js');
      const preview = previewUpdate(newCoreDir);

      expect(preview.filesChanged).toContain('src/new-file.ts');
      expect(preview.currentVersion).toBe('1.0.0');
    });

    it('detects changed files vs base', async () => {
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(baseDir, 'src/index.ts'), 'original');

      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      const newCoreDir = createNewCoreDir({
        'src/index.ts': 'modified',
      });

      const { previewUpdate } = await import('../update.js');
      const preview = previewUpdate(newCoreDir);

      expect(preview.filesChanged).toContain('src/index.ts');
    });

    it('does not list unchanged files', async () => {
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(baseDir, 'src/index.ts'), 'same content');

      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      const newCoreDir = createNewCoreDir({
        'src/index.ts': 'same content',
      });

      const { previewUpdate } = await import('../update.js');
      const preview = previewUpdate(newCoreDir);

      expect(preview.filesChanged).not.toContain('src/index.ts');
    });

    it('identifies conflict risk with applied skills', async () => {
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(baseDir, 'src/index.ts'), 'original');

      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [
          {
            name: 'telegram',
            version: '1.0.0',
            applied_at: new Date().toISOString(),
            file_hashes: { 'src/index.ts': 'abc123' },
          },
        ],
      });

      const newCoreDir = createNewCoreDir({
        'src/index.ts': 'updated core',
      });

      const { previewUpdate } = await import('../update.js');
      const preview = previewUpdate(newCoreDir);

      expect(preview.conflictRisk).toContain('src/index.ts');
    });

    it('identifies custom patches at risk', async () => {
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(baseDir, 'src/config.ts'), 'original');

      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
        custom_modifications: [
          {
            description: 'custom tweak',
            applied_at: new Date().toISOString(),
            files_modified: ['src/config.ts'],
            patch_file: '.nanoclaw/custom/001-tweak.patch',
          },
        ],
      });

      const newCoreDir = createNewCoreDir({
        'src/config.ts': 'updated core config',
      });

      const { previewUpdate } = await import('../update.js');
      const preview = previewUpdate(newCoreDir);

      expect(preview.customPatchesAtRisk).toContain('src/config.ts');
    });

    it('reads version from package.json in new core', async () => {
      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      const newCoreDir = createNewCoreDir({
        'package.json': JSON.stringify({ version: '2.0.0' }),
      });

      const { previewUpdate } = await import('../update.js');
      const preview = previewUpdate(newCoreDir);

      expect(preview.newVersion).toBe('2.0.0');
    });

    it('detects files deleted in new core', async () => {
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(baseDir, 'src/index.ts'), 'keep this');
      fs.writeFileSync(path.join(baseDir, 'src/removed.ts'), 'delete this');

      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      // New core only has index.ts — removed.ts is gone
      const newCoreDir = createNewCoreDir({
        'src/index.ts': 'keep this',
      });

      const { previewUpdate } = await import('../update.js');
      const preview = previewUpdate(newCoreDir);

      expect(preview.filesDeleted).toContain('src/removed.ts');
      expect(preview.filesChanged).not.toContain('src/removed.ts');
    });
  });

  describe('applyUpdate', () => {
    it('rejects when customize session is active', async () => {
      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      // Create the pending.yaml that indicates active customize
      const customDir = path.join(tmpDir, '.nanoclaw', 'custom');
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(path.join(customDir, 'pending.yaml'), 'active: true');

      const newCoreDir = createNewCoreDir({
        'src/index.ts': 'new content',
      });

      const { applyUpdate } = await import('../update.js');
      const result = await applyUpdate(newCoreDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain('customize session');
    });

    it('copies new files that do not exist yet', async () => {
      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      const newCoreDir = createNewCoreDir({
        'src/brand-new.ts': 'export const fresh = true;',
      });

      const { applyUpdate } = await import('../update.js');
      const result = await applyUpdate(newCoreDir);

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(
        fs.readFileSync(path.join(tmpDir, 'src/brand-new.ts'), 'utf-8'),
      ).toBe('export const fresh = true;');
    });

    it('performs clean three-way merge', async () => {
      // Set up base
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(baseDir, 'src/index.ts'),
        'line 1\nline 2\nline 3\n',
      );

      // Current has user changes at the bottom
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src/index.ts'),
        'line 1\nline 2\nline 3\nuser addition\n',
      );

      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      // New core changes at the top
      const newCoreDir = createNewCoreDir({
        'src/index.ts': 'core update\nline 1\nline 2\nline 3\n',
        'package.json': JSON.stringify({ version: '2.0.0' }),
      });

      const { applyUpdate } = await import('../update.js');
      const result = await applyUpdate(newCoreDir);

      expect(result.success).toBe(true);
      expect(result.newVersion).toBe('2.0.0');

      const merged = fs.readFileSync(
        path.join(tmpDir, 'src/index.ts'),
        'utf-8',
      );
      expect(merged).toContain('core update');
      expect(merged).toContain('user addition');
    });

    it('updates base directory after successful merge', async () => {
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(baseDir, 'src/index.ts'), 'old base');

      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src/index.ts'), 'old base');

      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      const newCoreDir = createNewCoreDir({
        'src/index.ts': 'new base content',
      });

      const { applyUpdate } = await import('../update.js');
      await applyUpdate(newCoreDir);

      const newBase = fs.readFileSync(
        path.join(tmpDir, '.nanoclaw', 'base', 'src/index.ts'),
        'utf-8',
      );
      expect(newBase).toBe('new base content');
    });

    it('updates core_version in state after success', async () => {
      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      const newCoreDir = createNewCoreDir({
        'package.json': JSON.stringify({ version: '2.0.0' }),
      });

      const { applyUpdate } = await import('../update.js');
      const result = await applyUpdate(newCoreDir);

      expect(result.success).toBe(true);
      expect(result.previousVersion).toBe('1.0.0');
      expect(result.newVersion).toBe('2.0.0');

      // Verify state file was updated
      const { readState } = await import('../state.js');
      const state = readState();
      expect(state.core_version).toBe('2.0.0');
    });

    it('restores backup on merge conflict', async () => {
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(baseDir, 'src/index.ts'),
        'line 1\nline 2\nline 3\n',
      );

      // Current has conflicting change on same line
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src/index.ts'),
        'line 1\nuser changed line 2\nline 3\n',
      );

      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      // New core also changes line 2 — guaranteed conflict
      const newCoreDir = createNewCoreDir({
        'src/index.ts': 'line 1\ncore changed line 2\nline 3\n',
      });

      const { applyUpdate } = await import('../update.js');
      const result = await applyUpdate(newCoreDir);

      expect(result.success).toBe(false);
      expect(result.mergeConflicts).toContain('src/index.ts');
      expect(result.backupPending).toBe(true);

      // File should have conflict markers (backup preserved, not restored)
      const content = fs.readFileSync(
        path.join(tmpDir, 'src/index.ts'),
        'utf-8',
      );
      expect(content).toContain('<<<<<<<');
      expect(content).toContain('>>>>>>>');
    });

    it('removes files deleted in new core', async () => {
      const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(baseDir, 'src/index.ts'), 'keep');
      fs.writeFileSync(path.join(baseDir, 'src/removed.ts'), 'old content');

      // Working tree has both files
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src/index.ts'), 'keep');
      fs.writeFileSync(path.join(tmpDir, 'src/removed.ts'), 'old content');

      writeStateFile({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      });

      // New core only has index.ts
      const newCoreDir = createNewCoreDir({
        'src/index.ts': 'keep',
      });

      const { applyUpdate } = await import('../update.js');
      const result = await applyUpdate(newCoreDir);

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'src/index.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'src/removed.ts'))).toBe(false);
    });
  });
});
