import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMPAT_INSTRUCTION_FILE,
  ensureInstructionAliases,
  INSTRUCTION_FILES,
  PRIMARY_INSTRUCTION_FILE,
  writeInstructionFiles,
} from './instruction-files.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-instructions-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeInstructionFiles', () => {
  it('creates the destination directory', () => {
    const nested = path.join(tmpDir, 'nested', 'agent');

    writeInstructionFiles(nested, 'Nested instructions');

    expect(fs.readFileSync(path.join(nested, 'CLAUDE.md'), 'utf-8')).toBe(
      'Nested instructions',
    );
  });

  it('writes the primary instruction file and compat alias content', () => {
    writeInstructionFiles(tmpDir, 'Follow the instructions.');

    for (const name of INSTRUCTION_FILES) {
      expect(fs.readFileSync(path.join(tmpDir, name), 'utf-8')).toBe(
        'Follow the instructions.',
      );
    }
  });

  it('refreshes an existing compat file when instructions change', () => {
    fs.writeFileSync(
      path.join(tmpDir, COMPAT_INSTRUCTION_FILE),
      'Old instructions',
    );

    writeInstructionFiles(tmpDir, 'New instructions');

    for (const name of INSTRUCTION_FILES) {
      expect(fs.readFileSync(path.join(tmpDir, name), 'utf-8')).toBe(
        'New instructions',
      );
    }
  });
});

describe('ensureInstructionAliases', () => {
  it('backfills the primary instruction file from compat memory', () => {
    fs.writeFileSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE), 'Compat');

    ensureInstructionAliases(tmpDir);

    expect(
      fs.readFileSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Compat');
  });

  it('backfills the compat instruction file from primary memory', () => {
    fs.writeFileSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE), 'Primary');

    ensureInstructionAliases(tmpDir);

    expect(
      fs.readFileSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Primary');
  });

  it('does not overwrite an existing alias file', () => {
    fs.writeFileSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE), 'Primary');
    fs.writeFileSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE), 'Compat');

    ensureInstructionAliases(tmpDir);

    expect(
      fs.readFileSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Primary');
    expect(
      fs.readFileSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Compat');
  });

  it('does nothing when neither instruction file exists', () => {
    ensureInstructionAliases(tmpDir);

    for (const name of INSTRUCTION_FILES) {
      expect(fs.existsSync(path.join(tmpDir, name))).toBe(false);
    }
  });

  it('creates aliases readable through either instruction filename', () => {
    fs.writeFileSync(
      path.join(tmpDir, PRIMARY_INSTRUCTION_FILE),
      'Shared instructions',
    );

    ensureInstructionAliases(tmpDir);

    for (const name of INSTRUCTION_FILES) {
      expect(fs.readFileSync(path.join(tmpDir, name), 'utf-8')).toBe(
        'Shared instructions',
      );
    }
  });
});
