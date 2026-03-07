import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { syncAgentRunnerSource } from './container-runner.js';
import { logger } from './logger.js';

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('syncAgentRunnerSource', () => {
  let tempDir: string;
  let repoSrc: string;
  let sessionRoot: string;
  let stagedDir: string;
  let metadataPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runner-sync-'));
    repoSrc = path.join(tempDir, 'repo-src');
    sessionRoot = path.join(tempDir, 'session');
    stagedDir = path.join(sessionRoot, 'agent-runner-src');
    metadataPath = path.join(sessionRoot, 'agent-runner-src.sync.json');
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('copies repo source and writes sync metadata for a new staged directory', () => {
    writeTextFile(
      path.join(repoSrc, 'ipc-mcp-stdio.ts'),
      'export const v = 1;\n',
    );

    syncAgentRunnerSource(repoSrc, stagedDir, metadataPath);

    expect(
      fs.readFileSync(path.join(stagedDir, 'ipc-mcp-stdio.ts'), 'utf8'),
    ).toBe('export const v = 1;\n');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as {
      baselineHash?: string;
    };
    expect(typeof metadata.baselineHash).toBe('string');
    expect(metadata.baselineHash).toHaveLength(64);
  });

  it('refreshes staged source when it still matches the previously synced baseline', () => {
    writeTextFile(
      path.join(repoSrc, 'ipc-mcp-stdio.ts'),
      'export const v = 1;\n',
    );
    syncAgentRunnerSource(repoSrc, stagedDir, metadataPath);

    writeTextFile(
      path.join(repoSrc, 'ipc-mcp-stdio.ts'),
      'export const v = 2;\n',
    );
    syncAgentRunnerSource(repoSrc, stagedDir, metadataPath);

    expect(
      fs.readFileSync(path.join(stagedDir, 'ipc-mcp-stdio.ts'), 'utf8'),
    ).toBe('export const v = 2;\n');
  });

  it('preserves locally customized staged source when repo baseline drifts', () => {
    writeTextFile(
      path.join(repoSrc, 'ipc-mcp-stdio.ts'),
      'export const repo = 1;\n',
    );
    syncAgentRunnerSource(repoSrc, stagedDir, metadataPath);

    writeTextFile(
      path.join(stagedDir, 'ipc-mcp-stdio.ts'),
      'export const local = true;\n',
    );
    writeTextFile(
      path.join(repoSrc, 'ipc-mcp-stdio.ts'),
      'export const repo = 2;\n',
    );

    syncAgentRunnerSource(repoSrc, stagedDir, metadataPath);

    expect(
      fs.readFileSync(path.join(stagedDir, 'ipc-mcp-stdio.ts'), 'utf8'),
    ).toBe('export const local = true;\n');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        groupAgentRunnerDir: stagedDir,
      }),
      'Preserving locally customized staged agent-runner source after repo drift',
    );
  });

  it('backs up and resets legacy staged source that has no sync metadata', () => {
    writeTextFile(
      path.join(repoSrc, 'ipc-mcp-stdio.ts'),
      'export const repo = 2;\n',
    );
    writeTextFile(
      path.join(stagedDir, 'ipc-mcp-stdio.ts'),
      'export const legacy = true;\n',
    );

    syncAgentRunnerSource(repoSrc, stagedDir, metadataPath);

    expect(
      fs.readFileSync(path.join(stagedDir, 'ipc-mcp-stdio.ts'), 'utf8'),
    ).toBe('export const repo = 2;\n');

    const backupDir = fs
      .readdirSync(sessionRoot)
      .find((entry) => entry.startsWith('agent-runner-src.backup-'));
    expect(backupDir).toBeTruthy();
    expect(
      fs.readFileSync(
        path.join(sessionRoot, backupDir!, 'ipc-mcp-stdio.ts'),
        'utf8',
      ),
    ).toBe('export const legacy = true;\n');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        backupPath: expect.stringContaining('agent-runner-src.backup-'),
      }),
      'Resetting legacy staged agent-runner source to repo baseline after backup',
    );
  });
});
