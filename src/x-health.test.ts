import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Mock logger before importing module under test
vi.mock('./logger.js', () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock runScript from x-ipc.js
const mockRunScript = vi.fn();
vi.mock('./x-ipc.js', () => ({
  runScript: (...args: unknown[]) => mockRunScript(...args),
}));

// Mock child_process.execFile
const mockExecFile = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('child_process')>();
  return {
    ...mod,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

import {
  checkXHealth,
  getInstalledVersion,
  getLatestVersion,
  updateOverride,
  runNpmInstall,
  attemptAutoUpdate,
  runXHealthCheck,
  startXHealthCheck,
} from './x-health.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// checkXHealth
// ---------------------------------------------------------------------------
describe('checkXHealth', () => {
  it('returns healthy when script succeeds', async () => {
    mockRunScript.mockResolvedValue({
      success: true,
      message: 'x-client-transaction-id is healthy',
      data: { isTransactionIdError: false },
    });

    const result = await checkXHealth();

    expect(result.healthy).toBe(true);
    expect(result.isTransactionIdError).toBe(false);
    expect(mockRunScript).toHaveBeenCalledWith('health-check', {}, 30_000);
  });

  it('returns unhealthy with isTransactionIdError for KEY_BYTE errors', async () => {
    mockRunScript.mockResolvedValue({
      success: false,
      message: "Health check failed: Couldn't get KEY_BYTE indices",
      data: { isTransactionIdError: true },
    });

    const result = await checkXHealth();

    expect(result.healthy).toBe(false);
    expect(result.isTransactionIdError).toBe(true);
    expect(result.message).toContain('KEY_BYTE');
  });

  it('returns unhealthy with isTransactionIdError=false for other errors', async () => {
    mockRunScript.mockResolvedValue({
      success: false,
      message: 'Network timeout',
      data: { isTransactionIdError: false },
    });

    const result = await checkXHealth();

    expect(result.healthy).toBe(false);
    expect(result.isTransactionIdError).toBe(false);
  });

  it('handles missing data field gracefully', async () => {
    mockRunScript.mockResolvedValue({
      success: false,
      message: 'Script timed out after 30s',
    });

    const result = await checkXHealth();

    expect(result.healthy).toBe(false);
    expect(result.isTransactionIdError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getInstalledVersion
// ---------------------------------------------------------------------------
describe('getInstalledVersion', () => {
  it('reads version from real node_modules', () => {
    const version = getInstalledVersion();
    // x-client-transaction-id should be installed (it's a dependency)
    expect(version).toBeTruthy();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns null when package is missing', () => {
    // Temporarily mock fs.readFileSync to throw
    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
      if (typeof p === 'string' && p.includes('x-client-transaction-id')) {
        throw new Error('ENOENT');
      }
      return originalReadFileSync(p, ...args);
    });

    const version = getInstalledVersion();
    expect(version).toBeNull();

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// getLatestVersion
// ---------------------------------------------------------------------------
describe('getLatestVersion', () => {
  it('returns parsed version on success', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, '0.2.1\n', '');
        return { unref: vi.fn() };
      },
    );

    const version = await getLatestVersion();
    expect(version).toBe('0.2.1');
  });

  it('returns null on error', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(new Error('npm ERR!'), '', 'npm ERR!');
        return { unref: vi.fn() };
      },
    );

    const version = await getLatestVersion();
    expect(version).toBeNull();
  });

  it('returns null on empty output', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, '', '');
        return { unref: vi.fn() };
      },
    );

    const version = await getLatestVersion();
    expect(version).toBeNull();
  });

  it('passes correct arguments to execFile', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, '0.2.0\n', '');
        return { unref: vi.fn() };
      },
    );

    await getLatestVersion();

    const expectedBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    expect(mockExecFile).toHaveBeenCalledWith(
      expectedBin,
      ['view', 'x-client-transaction-id', 'version'],
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------
// updateOverride
// ---------------------------------------------------------------------------
describe('updateOverride', () => {
  let tmpDir: string;
  let tmpPkgPath: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-health-test-'));
    tmpPkgPath = path.join(tmpDir, 'package.json');
    originalCwd = process.cwd();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('updates existing override version', () => {
    const original = {
      name: 'test',
      version: '1.0.0',
      overrides: { 'x-client-transaction-id': '0.1.9' },
    };
    fs.writeFileSync(tmpPkgPath, JSON.stringify(original, null, 2) + '\n');

    // We need to test the real function -- it reads from PROJECT_ROOT.
    // Instead, test the logic directly by reading the real package.json,
    // modifying it, and verifying. We'll use the actual updateOverride
    // on the real package.json but restore it afterwards.
    const realPkgPath = path.join(PROJECT_ROOT, 'package.json');
    const realContent = fs.readFileSync(realPkgPath, 'utf-8');
    const realPkg = JSON.parse(realContent);
    const originalOverride = realPkg.overrides?.['x-client-transaction-id'];

    try {
      updateOverride('9.9.9');
      const updated = JSON.parse(fs.readFileSync(realPkgPath, 'utf-8'));
      expect(updated.overrides['x-client-transaction-id']).toBe('9.9.9');
    } finally {
      // Restore original
      if (originalOverride !== undefined) {
        updateOverride(originalOverride);
      }
    }
  });

  it('preserves other package.json fields', () => {
    const realPkgPath = path.join(PROJECT_ROOT, 'package.json');
    const before = JSON.parse(fs.readFileSync(realPkgPath, 'utf-8'));
    const originalOverride = before.overrides?.['x-client-transaction-id'];

    try {
      updateOverride('8.8.8');
      const after = JSON.parse(fs.readFileSync(realPkgPath, 'utf-8'));

      // Key fields preserved
      expect(after.name).toBe(before.name);
      expect(after.version).toBe(before.version);
      expect(after.dependencies).toEqual(before.dependencies);
      expect(after.devDependencies).toEqual(before.devDependencies);
      expect(after.overrides['x-client-transaction-id']).toBe('8.8.8');
    } finally {
      if (originalOverride !== undefined) {
        updateOverride(originalOverride);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// runNpmInstall
// ---------------------------------------------------------------------------
describe('runNpmInstall', () => {
  it('returns true on success', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, 'added 0 packages\n', '');
        return { unref: vi.fn() };
      },
    );

    const result = await runNpmInstall();
    expect(result).toBe(true);
  });

  it('returns false on error', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(new Error('npm ERR!'), '', 'npm ERR! peer dep conflict');
        return { unref: vi.fn() };
      },
    );

    const result = await runNpmInstall();
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// attemptAutoUpdate
// ---------------------------------------------------------------------------
describe('attemptAutoUpdate', () => {
  it('skips update when already on latest version', async () => {
    // Mock getInstalledVersion via fs.readFileSync (reads real node_modules)
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
      if (typeof p === 'string' && p.includes('x-client-transaction-id/package.json')) {
        return JSON.stringify({ version: '0.2.0' });
      }
      return fs.readFileSync.call(fs, p, ...args);
    });

    // Mock getLatestVersion
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, '0.2.0\n', '');
        return { unref: vi.fn() };
      },
    );

    const result = await attemptAutoUpdate();
    expect(result).toBe(false);

    vi.restoreAllMocks();
  });

  it('skips update when npm view fails', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(new Error('network error'), '', '');
        return { unref: vi.fn() };
      },
    );

    const result = await attemptAutoUpdate();
    expect(result).toBe(false);
  });

  it('returns true when update fixes the issue', async () => {
    // First getInstalledVersion reads 0.1.9
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
      if (typeof p === 'string' && p.includes('x-client-transaction-id/package.json')) {
        return JSON.stringify({ version: '0.1.9' });
      }
      // For updateOverride, return a real-ish package.json
      if (typeof p === 'string' && p.endsWith('package.json') && !p.includes('node_modules')) {
        return JSON.stringify({ name: 'test', overrides: {} }, null, 2);
      }
      return fs.readFileSync.call(fs, p, ...args);
    });

    // Mock fs.writeFileSync to be a no-op for updateOverride
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    // Mock execFile for both getLatestVersion and runNpmInstall
    let execCallCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: object, cb: Function) => {
        execCallCount++;
        if (args.includes('view')) {
          cb(null, '0.2.1\n', '');
        } else {
          // npm install
          cb(null, 'added 1 package\n', '');
        }
        return { unref: vi.fn() };
      },
    );

    // Mock runScript for the re-check (called by checkXHealth)
    mockRunScript.mockResolvedValue({
      success: true,
      message: 'healthy',
      data: { isTransactionIdError: false },
    });

    const result = await attemptAutoUpdate();
    expect(result).toBe(true);

    vi.restoreAllMocks();
  });

  it('returns false when update does not fix the issue', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
      if (typeof p === 'string' && p.includes('x-client-transaction-id/package.json')) {
        return JSON.stringify({ version: '0.1.9' });
      }
      if (typeof p === 'string' && p.endsWith('package.json') && !p.includes('node_modules')) {
        return JSON.stringify({ name: 'test', overrides: {} }, null, 2);
      }
      return fs.readFileSync.call(fs, p, ...args);
    });

    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: object, cb: Function) => {
        if (args.includes('view')) {
          cb(null, '0.2.1\n', '');
        } else {
          cb(null, 'ok\n', '');
        }
        return { unref: vi.fn() };
      },
    );

    // Re-check still fails
    mockRunScript.mockResolvedValue({
      success: false,
      message: "Couldn't get KEY_BYTE indices",
      data: { isTransactionIdError: true },
    });

    const result = await attemptAutoUpdate();
    expect(result).toBe(false);

    vi.restoreAllMocks();
  });

  it('returns false when npm install fails', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
      if (typeof p === 'string' && p.includes('x-client-transaction-id/package.json')) {
        return JSON.stringify({ version: '0.1.9' });
      }
      if (typeof p === 'string' && p.endsWith('package.json') && !p.includes('node_modules')) {
        return JSON.stringify({ name: 'test', overrides: {} }, null, 2);
      }
      return fs.readFileSync.call(fs, p, ...args);
    });

    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: object, cb: Function) => {
        if (args.includes('view')) {
          cb(null, '0.2.1\n', '');
        } else {
          cb(new Error('npm ERR!'), '', 'npm ERR!');
        }
        return { unref: vi.fn() };
      },
    );

    const result = await attemptAutoUpdate();
    expect(result).toBe(false);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// runXHealthCheck
// ---------------------------------------------------------------------------
describe('runXHealthCheck', () => {
  it('does nothing extra when healthy', async () => {
    mockRunScript.mockResolvedValue({
      success: true,
      message: 'healthy',
      data: { isTransactionIdError: false },
    });

    await runXHealthCheck();

    // Only one call to runScript (the health check itself)
    expect(mockRunScript).toHaveBeenCalledTimes(1);
    // No npm operations
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('skips auto-update for non-transaction-ID errors', async () => {
    mockRunScript.mockResolvedValue({
      success: false,
      message: 'Network timeout',
      data: { isTransactionIdError: false },
    });

    await runXHealthCheck();

    // Only the health check call
    expect(mockRunScript).toHaveBeenCalledTimes(1);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('attempts auto-update for transaction-ID errors', async () => {
    // First call: health check fails with KEY_BYTE
    // Second call: re-check after update succeeds
    mockRunScript
      .mockResolvedValueOnce({
        success: false,
        message: "Couldn't get KEY_BYTE indices",
        data: { isTransactionIdError: true },
      })
      .mockResolvedValueOnce({
        success: true,
        message: 'healthy',
        data: { isTransactionIdError: false },
      });

    // Mock fs for getInstalledVersion and updateOverride
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
      if (typeof p === 'string' && p.includes('x-client-transaction-id/package.json')) {
        return JSON.stringify({ version: '0.1.9' });
      }
      if (typeof p === 'string' && p.endsWith('package.json') && !p.includes('node_modules')) {
        return JSON.stringify({ name: 'test', overrides: {} }, null, 2);
      }
      return fs.readFileSync.call(fs, p, ...args);
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: object, cb: Function) => {
        if (args.includes('view')) {
          cb(null, '0.2.1\n', '');
        } else {
          cb(null, 'ok\n', '');
        }
        return { unref: vi.fn() };
      },
    );

    await runXHealthCheck();

    // Health check was called twice (initial + re-check)
    expect(mockRunScript).toHaveBeenCalledTimes(2);
    // npm operations happened (view + install)
    expect(mockExecFile).toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// startXHealthCheck
// ---------------------------------------------------------------------------
describe('startXHealthCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs initial check after 30s delay', async () => {
    mockRunScript.mockResolvedValue({
      success: true,
      message: 'healthy',
      data: { isTransactionIdError: false },
    });

    const stop = startXHealthCheck(60_000);

    // Before 30s: no calls
    expect(mockRunScript).not.toHaveBeenCalled();

    // Advance to 30s
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockRunScript).toHaveBeenCalledTimes(1);

    stop();
  });

  it('runs on interval after initial delay', async () => {
    mockRunScript.mockResolvedValue({
      success: true,
      message: 'healthy',
      data: { isTransactionIdError: false },
    });

    const intervalMs = 60_000;
    const stop = startXHealthCheck(intervalMs);

    // Advance past initial delay
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockRunScript).toHaveBeenCalledTimes(1);

    // Advance one interval
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(mockRunScript).toHaveBeenCalledTimes(2);

    // Advance another interval
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(mockRunScript).toHaveBeenCalledTimes(3);

    stop();
  });

  it('cleanup function stops the interval', async () => {
    mockRunScript.mockResolvedValue({
      success: true,
      message: 'healthy',
      data: { isTransactionIdError: false },
    });

    const stop = startXHealthCheck(60_000);

    // Advance past initial delay
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockRunScript).toHaveBeenCalledTimes(1);

    // Stop before next interval fires
    stop();

    await vi.advanceTimersByTimeAsync(60_000);
    // Should still be 1 -- no new calls after stop
    expect(mockRunScript).toHaveBeenCalledTimes(1);
  });

  it('cleanup function works before initial delay fires', async () => {
    const stop = startXHealthCheck(60_000);

    // Stop immediately
    stop();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockRunScript).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRunScript).not.toHaveBeenCalled();
  });
});
