import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('./log.js', () => ({
  log: mockLog,
}));

let allowlistPath: string;

vi.mock('./config.js', () => ({
  get MOUNT_ALLOWLIST_PATH() {
    return allowlistPath;
  },
}));

describe('validateMount', () => {
  let tempDir: string;
  let validateMount: typeof import('./mount-security.js').validateMount;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mounts-'));
    allowlistPath = path.join(tempDir, 'mount-allowlist.json');
    ({ validateMount } = await import('./mount-security.js'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('rejects file mounts outside allowed roots and explains that only parent directories are supported', () => {
    const privateDir = path.join(tempDir, 'private-files');
    fs.mkdirSync(privateDir, { recursive: true });
    const tokenFile = path.join(privateDir, 'pomoclaw-token');
    fs.writeFileSync(tokenFile, 'secret');

    const safeDir = path.join(tempDir, 'shared');
    fs.mkdirSync(safeDir, { recursive: true });

    fs.writeFileSync(
      allowlistPath,
      JSON.stringify(
        {
          allowedRoots: [
            {
              path: safeDir,
              allowReadWrite: false,
              description: 'Shared files',
            },
          ],
          blockedPatterns: [],
        },
        null,
        2,
      ),
    );

    const result = validateMount({
      hostPath: tokenFile,
      containerPath: 'pomoclaw-token',
      readonly: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
    expect(result.reason).toContain('Only parent directories can be allowlisted');
    expect(result.reason).toContain(`Parent directory: "${privateDir}"`);
  });

  it('accepts directories under allowed roots', () => {
    const sharedDir = path.join(tempDir, 'shared');
    fs.mkdirSync(sharedDir, { recursive: true });

    fs.writeFileSync(
      allowlistPath,
      JSON.stringify(
        {
          allowedRoots: [
            {
              path: sharedDir,
              allowReadWrite: false,
              description: 'Shared files',
            },
          ],
          blockedPatterns: [],
        },
        null,
        2,
      ),
    );

    const result = validateMount({
      hostPath: sharedDir,
      containerPath: 'shared',
      readonly: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe(fs.realpathSync(sharedDir));
    expect(result.effectiveReadonly).toBe(true);
  });
});
