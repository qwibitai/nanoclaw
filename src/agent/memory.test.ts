import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CANONICAL_MEMORY_FILE,
  LEGACY_CLAUDE_MEMORY_FILE,
  getGlobalMemoryPolicy,
  reconcileCompatibilityMemory,
  resolveMemoryLayout,
  seedGroupMemoryFiles,
} from './memory.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-test-'));
}

function writeMemoryFile(
  dir: string,
  fileName: string,
  content: string,
): string {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('memory helper', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers AGENT.md over legacy CLAUDE.md as the authoritative memory file', () => {
    // Arrange
    const groupDir = createTempDir();
    tempDirs.push(groupDir);
    writeMemoryFile(groupDir, CANONICAL_MEMORY_FILE, '# Canonical\n');
    writeMemoryFile(groupDir, LEGACY_CLAUDE_MEMORY_FILE, '# Compatibility\n');

    // Act
    const layout = resolveMemoryLayout(groupDir);

    // Assert
    expect(layout.authoritative?.path).toBe(
      path.join(groupDir, CANONICAL_MEMORY_FILE),
    );
    expect(layout.authoritative?.authority).toBe('canonical');
    expect(layout.compatibility.authority).toBe('provider-rendered');
  });

  it('seeds AGENT.md from legacy CLAUDE.md without overwriting the user file', () => {
    // Arrange
    const groupDir = createTempDir();
    const templateDir = createTempDir();
    tempDirs.push(groupDir, templateDir);
    const legacyContent = '# Custom Claude Memory\n\nKeep this exactly.';
    writeMemoryFile(groupDir, LEGACY_CLAUDE_MEMORY_FILE, legacyContent);

    // Act
    const seeded = seedGroupMemoryFiles({
      targetDir: groupDir,
      templateDir,
    });

    // Assert
    expect(seeded.canonical.created).toBe(true);
    expect(seeded.canonical.seededFrom).toBe('legacy-seed');
    expect(
      fs.readFileSync(path.join(groupDir, CANONICAL_MEMORY_FILE), 'utf-8'),
    ).toBe(legacyContent);
    expect(
      fs.readFileSync(path.join(groupDir, LEGACY_CLAUDE_MEMORY_FILE), 'utf-8'),
    ).toBe(legacyContent);
  });

  it('creates AGENT.md from the canonical template and renders CLAUDE.md for compatibility', () => {
    // Arrange
    const groupDir = createTempDir();
    const templateDir = createTempDir();
    tempDirs.push(groupDir, templateDir);
    writeMemoryFile(
      templateDir,
      CANONICAL_MEMORY_FILE,
      '# Template Agent\n\nCanonical instructions.\n',
    );

    // Act
    const seeded = seedGroupMemoryFiles({
      targetDir: groupDir,
      templateDir,
    });

    // Assert
    expect(seeded.canonical.created).toBe(true);
    expect(seeded.canonical.seededFrom).toBe('template-canonical');
    expect(seeded.compatibility.created).toBe(true);
    expect(
      fs.readFileSync(path.join(groupDir, CANONICAL_MEMORY_FILE), 'utf-8'),
    ).toBe('# Template Agent\n\nCanonical instructions.\n');
    expect(
      fs.readFileSync(path.join(groupDir, LEGACY_CLAUDE_MEMORY_FILE), 'utf-8'),
    ).toBe('# Template Agent\n\nCanonical instructions.\n');
  });

  it('does not overwrite existing AGENT.md or provider compatibility files during seeding', () => {
    // Arrange
    const groupDir = createTempDir();
    const templateDir = createTempDir();
    tempDirs.push(groupDir, templateDir);
    writeMemoryFile(groupDir, CANONICAL_MEMORY_FILE, '# User Agent Memory\n');
    writeMemoryFile(
      groupDir,
      LEGACY_CLAUDE_MEMORY_FILE,
      '# User Claude Compatibility\n',
    );
    writeMemoryFile(templateDir, CANONICAL_MEMORY_FILE, '# Template Agent\n');

    // Act
    const seeded = seedGroupMemoryFiles({
      targetDir: groupDir,
      templateDir,
    });

    // Assert
    expect(seeded.canonical.created).toBe(false);
    expect(seeded.compatibility.created).toBe(false);
    expect(
      fs.readFileSync(path.join(groupDir, CANONICAL_MEMORY_FILE), 'utf-8'),
    ).toBe('# User Agent Memory\n');
    expect(
      fs.readFileSync(path.join(groupDir, LEGACY_CLAUDE_MEMORY_FILE), 'utf-8'),
    ).toBe('# User Claude Compatibility\n');
  });

  it('treats non-main global memory as readable but never syncs provider edits back', () => {
    // Arrange
    const projectRoot = createTempDir();
    tempDirs.push(projectRoot);
    const globalDir = path.join(projectRoot, 'groups', 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    const policy = getGlobalMemoryPolicy(projectRoot, false);
    const canonicalPath = writeMemoryFile(
      globalDir,
      CANONICAL_MEMORY_FILE,
      '# Canonical Global\n',
    );
    const compatibilityPath = writeMemoryFile(
      globalDir,
      LEGACY_CLAUDE_MEMORY_FILE,
      '# Provider Edited Global\n',
    );

    // Act
    const reconciliation = reconcileCompatibilityMemory({
      canonicalPath,
      compatibilityPath,
      allowSyncBack: policy.allowCompatibilitySyncBack,
    });

    // Assert
    expect(policy.canonicalPath).toBe(canonicalPath);
    expect(policy.allowCompatibilitySyncBack).toBe(false);
    expect(reconciliation.status).toBe('skipped');
    expect(fs.readFileSync(canonicalPath, 'utf-8')).toBe(
      '# Canonical Global\n',
    );
  });

  it('emits a warning when compatibility sync-back is requested without canonical memory', () => {
    // Arrange
    const groupDir = createTempDir();
    tempDirs.push(groupDir);
    const compatibilityPath = writeMemoryFile(
      groupDir,
      LEGACY_CLAUDE_MEMORY_FILE,
      '# Provider Edited Memory\n',
    );
    const warnings: string[] = [];

    // Act
    const reconciliation = reconcileCompatibilityMemory({
      canonicalPath: path.join(groupDir, CANONICAL_MEMORY_FILE),
      compatibilityPath,
      allowSyncBack: true,
      onWarning: (warning) => warnings.push(warning),
    });

    // Assert
    expect(reconciliation.status).toBe('warning');
    expect(reconciliation.warning).toContain(CANONICAL_MEMORY_FILE);
    expect(warnings).toEqual([reconciliation.warning]);
  });
});
