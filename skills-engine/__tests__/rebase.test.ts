import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { rebase } from '../rebase.js';
import {
  cleanup,
  createMinimalState,
  createTempDir,
  initGitRepo,
  setupNanoclawDir,
  writeState,
} from './test-helpers.js';

describe('rebase', () => {
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

  it('rebase with one skill: patch created, state updated, rebased_at set', async () => {
    // Set up base file
    const baseDir = path.join(tmpDir, '.nanoclaw', 'base', 'src');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'index.ts'), 'const x = 1;\n');

    // Set up working tree with skill modification
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'index.ts'),
      'const x = 1;\nconst y = 2; // added by skill\n',
    );

    // Write state with applied skill
    writeState(tmpDir, {
      skills_system_version: '0.1.0',
      core_version: '1.0.0',
      applied_skills: [
        {
          name: 'test-skill',
          version: '1.0.0',
          applied_at: new Date().toISOString(),
          file_hashes: {
            'src/index.ts': 'abc123',
          },
        },
      ],
    });

    initGitRepo(tmpDir);

    const result = await rebase();

    expect(result.success).toBe(true);
    expect(result.filesInPatch).toBeGreaterThan(0);
    expect(result.rebased_at).toBeDefined();
    expect(result.patchFile).toBeDefined();

    // Verify patch file exists
    const patchPath = path.join(tmpDir, '.nanoclaw', 'combined.patch');
    expect(fs.existsSync(patchPath)).toBe(true);

    const patchContent = fs.readFileSync(patchPath, 'utf-8');
    expect(patchContent).toContain('added by skill');

    // Verify state was updated
    const stateContent = fs.readFileSync(
      path.join(tmpDir, '.nanoclaw', 'state.yaml'),
      'utf-8',
    );
    const state = parse(stateContent);
    expect(state.rebased_at).toBeDefined();
    expect(state.applied_skills).toHaveLength(1);
    expect(state.applied_skills[0].name).toBe('test-skill');

    // File hashes should be updated to actual current values
    const currentHash = state.applied_skills[0].file_hashes['src/index.ts'];
    expect(currentHash).toBeDefined();
    expect(currentHash).not.toBe('abc123'); // Should be recomputed

    // Working tree file should still have the skill's changes
    const workingContent = fs.readFileSync(
      path.join(tmpDir, 'src', 'index.ts'),
      'utf-8',
    );
    expect(workingContent).toContain('added by skill');
  });

  it('rebase flattens: base updated to match working tree', async () => {
    // Set up base file (clean core)
    const baseDir = path.join(tmpDir, '.nanoclaw', 'base', 'src');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'index.ts'), 'const x = 1;\n');

    // Working tree has skill modification
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'index.ts'),
      'const x = 1;\nconst y = 2; // skill\n',
    );

    writeState(tmpDir, {
      skills_system_version: '0.1.0',
      core_version: '1.0.0',
      applied_skills: [
        {
          name: 'my-skill',
          version: '1.0.0',
          applied_at: new Date().toISOString(),
          file_hashes: {
            'src/index.ts': 'oldhash',
          },
        },
      ],
    });

    initGitRepo(tmpDir);

    const result = await rebase();
    expect(result.success).toBe(true);

    // Base should now include the skill's changes (flattened)
    const baseContent = fs.readFileSync(
      path.join(tmpDir, '.nanoclaw', 'base', 'src', 'index.ts'),
      'utf-8',
    );
    expect(baseContent).toContain('skill');
    expect(baseContent).toBe('const x = 1;\nconst y = 2; // skill\n');
  });

  it('rebase with multiple skills + custom mods: all collapsed into single patch', async () => {
    // Set up base files
    const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
    fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'src', 'index.ts'), 'const x = 1;\n');
    fs.writeFileSync(
      path.join(baseDir, 'src', 'config.ts'),
      'export const port = 3000;\n',
    );

    // Set up working tree with modifications from multiple skills
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'index.ts'),
      'const x = 1;\nconst y = 2; // skill-a\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'config.ts'),
      'export const port = 3000;\nexport const host = "0.0.0.0"; // skill-b\n',
    );
    // File added by skill
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'plugin.ts'),
      'export const plugin = true;\n',
    );

    // Write state with multiple skills and custom modifications
    writeState(tmpDir, {
      skills_system_version: '0.1.0',
      core_version: '1.0.0',
      applied_skills: [
        {
          name: 'skill-a',
          version: '1.0.0',
          applied_at: new Date().toISOString(),
          file_hashes: {
            'src/index.ts': 'hash-a1',
          },
        },
        {
          name: 'skill-b',
          version: '2.0.0',
          applied_at: new Date().toISOString(),
          file_hashes: {
            'src/config.ts': 'hash-b1',
            'src/plugin.ts': 'hash-b2',
          },
        },
      ],
      custom_modifications: [
        {
          description: 'tweaked config',
          applied_at: new Date().toISOString(),
          files_modified: ['src/config.ts'],
          patch_file: '.nanoclaw/custom/001-tweaked-config.patch',
        },
      ],
    });

    initGitRepo(tmpDir);

    const result = await rebase();

    expect(result.success).toBe(true);
    expect(result.filesInPatch).toBeGreaterThanOrEqual(2);

    // Verify combined patch includes changes from both skills
    const patchContent = fs.readFileSync(
      path.join(tmpDir, '.nanoclaw', 'combined.patch'),
      'utf-8',
    );
    expect(patchContent).toContain('skill-a');
    expect(patchContent).toContain('skill-b');

    // Verify state: custom_modifications should be cleared
    const stateContent = fs.readFileSync(
      path.join(tmpDir, '.nanoclaw', 'state.yaml'),
      'utf-8',
    );
    const state = parse(stateContent);
    expect(state.custom_modifications).toBeUndefined();
    expect(state.rebased_at).toBeDefined();

    // applied_skills should still be present (informational)
    expect(state.applied_skills).toHaveLength(2);

    // Base should be flattened — include all skill changes
    const baseIndex = fs.readFileSync(
      path.join(tmpDir, '.nanoclaw', 'base', 'src', 'index.ts'),
      'utf-8',
    );
    expect(baseIndex).toContain('skill-a');

    const baseConfig = fs.readFileSync(
      path.join(tmpDir, '.nanoclaw', 'base', 'src', 'config.ts'),
      'utf-8',
    );
    expect(baseConfig).toContain('skill-b');
  });

  it('rebase with new base: base updated, changes merged', async () => {
    // Set up current base (multi-line so changes don't conflict)
    const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
    fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(baseDir, 'src', 'index.ts'),
      'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n',
    );

    // Working tree: skill adds at bottom
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'index.ts'),
      'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nskill change\n',
    );

    writeState(tmpDir, {
      skills_system_version: '0.1.0',
      core_version: '1.0.0',
      applied_skills: [
        {
          name: 'my-skill',
          version: '1.0.0',
          applied_at: new Date().toISOString(),
          file_hashes: {
            'src/index.ts': 'oldhash',
          },
        },
      ],
    });

    initGitRepo(tmpDir);

    // New base: core update at top
    const newBase = path.join(tmpDir, 'new-core');
    fs.mkdirSync(path.join(newBase, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(newBase, 'src', 'index.ts'),
      'core v2 header\nline1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n',
    );

    const result = await rebase(newBase);

    expect(result.success).toBe(true);
    expect(result.patchFile).toBeDefined();

    // Verify base was updated to new core
    const baseContent = fs.readFileSync(
      path.join(tmpDir, '.nanoclaw', 'base', 'src', 'index.ts'),
      'utf-8',
    );
    expect(baseContent).toContain('core v2 header');

    // Working tree should have both core v2 and skill changes merged
    const workingContent = fs.readFileSync(
      path.join(tmpDir, 'src', 'index.ts'),
      'utf-8',
    );
    expect(workingContent).toContain('core v2 header');
    expect(workingContent).toContain('skill change');

    // State should reflect rebase
    const stateContent = fs.readFileSync(
      path.join(tmpDir, '.nanoclaw', 'state.yaml'),
      'utf-8',
    );
    const state = parse(stateContent);
    expect(state.rebased_at).toBeDefined();
  });

  it('rebase with new base: conflict returns backupPending', async () => {
    // Set up current base — short file so changes overlap
    const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
    fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'src', 'index.ts'), 'const x = 1;\n');

    // Working tree: skill replaces the same line
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'index.ts'),
      'const x = 42; // skill override\n',
    );

    writeState(tmpDir, {
      skills_system_version: '0.1.0',
      core_version: '1.0.0',
      applied_skills: [
        {
          name: 'my-skill',
          version: '1.0.0',
          applied_at: new Date().toISOString(),
          file_hashes: {
            'src/index.ts': 'oldhash',
          },
        },
      ],
    });

    initGitRepo(tmpDir);

    // New base: also changes the same line — guaranteed conflict
    const newBase = path.join(tmpDir, 'new-core');
    fs.mkdirSync(path.join(newBase, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(newBase, 'src', 'index.ts'),
      'const x = 999; // core v2\n',
    );

    const result = await rebase(newBase);

    expect(result.success).toBe(false);
    expect(result.mergeConflicts).toContain('src/index.ts');
    expect(result.backupPending).toBe(true);
    expect(result.error).toContain('Merge conflicts');

    // combined.patch should still exist
    expect(result.patchFile).toBeDefined();
    const patchPath = path.join(tmpDir, '.nanoclaw', 'combined.patch');
    expect(fs.existsSync(patchPath)).toBe(true);

    // Working tree should have conflict markers (not rolled back)
    const workingContent = fs.readFileSync(
      path.join(tmpDir, 'src', 'index.ts'),
      'utf-8',
    );
    expect(workingContent).toContain('<<<<<<<');
    expect(workingContent).toContain('>>>>>>>');

    // State should NOT be updated yet (conflicts pending)
    const stateContent = fs.readFileSync(
      path.join(tmpDir, '.nanoclaw', 'state.yaml'),
      'utf-8',
    );
    const state = parse(stateContent);
    expect(state.rebased_at).toBeUndefined();
  });

  it('error when no skills applied', async () => {
    // State has no applied skills (created by createMinimalState)
    initGitRepo(tmpDir);

    const result = await rebase();

    expect(result.success).toBe(false);
    expect(result.error).toContain('No skills applied');
    expect(result.filesInPatch).toBe(0);
  });
});
