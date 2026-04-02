import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs and config before importing the module under test
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => '{}'),
    realpathSync: vi.fn((p: string) => p),
  },
}));

vi.mock('../config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/mock/mount-allowlist.json',
}));

// Suppress pino logs during tests
vi.mock('pino', () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { default: () => logger };
});

import fs from 'fs';
import { validateMount } from '../mount-security.js';
import type { MountAllowlist } from '../types.js';

/**
 * Helper: configure the mocked fs to return a specific allowlist.
 * Also clears the module-level cache by re-importing.
 */
function setAllowlist(allowlist: MountAllowlist) {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(allowlist));
  // realpathSync just echoes the path (no symlinks in tests)
  vi.mocked(fs.realpathSync).mockImplementation((p) => String(p) as any);
}

describe('bypassNonMainReadOnly flag', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function freshValidateMount(...args: Parameters<typeof validateMount>) {
    // Re-import to clear the cached allowlist
    const mod = await import('../mount-security.js');
    return mod.validateMount(...args);
  }

  it('non-main group with bypassNonMainReadOnly root gets read-write', async () => {
    setAllowlist({
      allowedRoots: [
        {
          path: '/data/shared',
          allowReadWrite: true,
          bypassNonMainReadOnly: true,
          description: 'Shared data',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const result = await freshValidateMount(
      { hostPath: '/data/shared/file.txt', readonly: false },
      false, // non-main
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('non-main group with normal root is forced read-only', async () => {
    setAllowlist({
      allowedRoots: [
        {
          path: '/data/normal',
          allowReadWrite: true,
          description: 'Normal data',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const result = await freshValidateMount(
      { hostPath: '/data/normal/file.txt', readonly: false },
      false, // non-main
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('main group is unaffected by bypassNonMainReadOnly', async () => {
    setAllowlist({
      allowedRoots: [
        {
          path: '/data/shared',
          allowReadWrite: true,
          bypassNonMainReadOnly: true,
          description: 'Shared data',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const result = await freshValidateMount(
      { hostPath: '/data/shared/file.txt', readonly: false },
      true, // main
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('bypassNonMainReadOnly with allowReadWrite false stays read-only', async () => {
    setAllowlist({
      allowedRoots: [
        {
          path: '/data/shared',
          allowReadWrite: false,
          bypassNonMainReadOnly: true,
          description: 'Read-only root despite bypass flag',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const result = await freshValidateMount(
      { hostPath: '/data/shared/file.txt', readonly: false },
      false, // non-main
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });
});
