import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MOUNT_ALLOWLIST_PATH } from '../../config.js';

// The module caches the parsed allowlist process-wide. To exercise multiple
// allowlist shapes from one test file we need a fresh import every time —
// which means dynamic import() inside vi.resetModules() boundaries.
async function freshImport() {
  vi.resetModules();
  return import('./index.js');
}

let tmpHome: string;
let originalAllowlistPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mount-test-'));
  // The module reads from a path resolved at config-import time, so we can't
  // redirect cleanly without overriding HOME for a separate process. Instead,
  // back up the real allowlist (if any) and write into the live location.
  originalAllowlistPath = MOUNT_ALLOWLIST_PATH;
  fs.mkdirSync(path.dirname(originalAllowlistPath), { recursive: true });
  if (fs.existsSync(originalAllowlistPath)) {
    fs.copyFileSync(originalAllowlistPath, path.join(tmpHome, 'allowlist.bak'));
  }
});

afterEach(() => {
  // Restore (or delete) the real allowlist after each test
  const backup = path.join(tmpHome, 'allowlist.bak');
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, originalAllowlistPath);
  } else if (fs.existsSync(originalAllowlistPath)) {
    fs.unlinkSync(originalAllowlistPath);
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeAllowlist(content: unknown) {
  fs.writeFileSync(MOUNT_ALLOWLIST_PATH, JSON.stringify(content));
}

describe('validateMount — structural validation', () => {
  beforeEach(() => {
    writeAllowlist({
      allowedRoots: [{ path: tmpHome, allowReadWrite: false }],
      blockedPatterns: [],
    });
  });

  it('rejects mount missing hostPath with a clear message', async () => {
    const { validateMount } = await freshImport();
    const result = validateMount({} as never);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/missing required field "hostPath"/);
  });

  it('rejects Docker shorthand (source/target/mode) with a hint to the right keys', async () => {
    const { validateMount } = await freshImport();
    const result = validateMount({ source: tmpHome, target: 'foo', mode: 'ro' } as never);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Docker shorthand/);
    expect(result.reason).toMatch(/hostPath/);
    expect(result.reason).toMatch(/containerPath/);
    expect(result.reason).toMatch(/readonly/);
  });

  it('rejects null mount entry without throwing', async () => {
    const { validateMount } = await freshImport();
    expect(() => validateMount(null as never)).not.toThrow();
    const result = validateMount(null as never);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Mount entry must be an object/);
  });

  it('rejects non-string containerPath', async () => {
    const { validateMount } = await freshImport();
    const result = validateMount({ hostPath: tmpHome, containerPath: 42 as unknown as string });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/"containerPath" must be a string/);
  });

  it('rejects non-boolean readonly', async () => {
    const { validateMount } = await freshImport();
    const result = validateMount({ hostPath: tmpHome, readonly: 'yes' as unknown as boolean });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/"readonly" must be a boolean/);
  });

  it('accepts a well-formed mount under an allowed root', async () => {
    const { validateMount } = await freshImport();
    const result = validateMount({ hostPath: tmpHome, containerPath: 'data', readonly: true });
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('data');
    expect(result.effectiveReadonly).toBe(true);
  });
});

describe('loadMountAllowlist — allowedRoots structural validation', () => {
  it('rejects bare-string allowedRoots entries with a clear message', async () => {
    writeAllowlist({
      // Intentionally malformed — bare strings instead of objects
      allowedRoots: ['/some/path'],
      blockedPatterns: [],
    });
    const { loadMountAllowlist } = await freshImport();
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('rejects entries missing path', async () => {
    writeAllowlist({
      allowedRoots: [{ allowReadWrite: false }],
      blockedPatterns: [],
    });
    const { loadMountAllowlist } = await freshImport();
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('accepts a properly shaped allowlist', async () => {
    writeAllowlist({
      allowedRoots: [{ path: tmpHome, allowReadWrite: false, description: 'test' }],
      blockedPatterns: [],
    });
    const { loadMountAllowlist } = await freshImport();
    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result?.allowedRoots).toHaveLength(1);
    expect(result?.allowedRoots[0].path).toBe(tmpHome);
  });
});
