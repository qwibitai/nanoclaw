import { describe, it, expect, beforeEach, vi } from 'vitest';

// We test matchesBlockedPattern via the validateMount path.
// Direct unit test of the internals via monkey-patching is fragile; instead
// we validate the observable behaviour that matters for security.

// We mock the filesystem so we don't need real paths.
vi.mock('fs');
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/fake/.config/nanoclaw/mount-allowlist.json',
}));

import fs from 'fs';

const mockFs = fs as unknown as {
  existsSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  realpathSync: ReturnType<typeof vi.fn>;
};

// Reset module cache between tests so cachedAllowlist is cleared
describe('mount-security: matchesBlockedPattern (exact match)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  async function makeValidateMount() {
    // After resetting modules we need a fresh import
    const mod = await import('./mount-security.js');
    return mod;
  }

  it('blocks path whose component exactly equals a blocked pattern', async () => {
    mockFs.existsSync = vi.fn().mockReturnValue(true);
    mockFs.readFileSync = vi.fn().mockReturnValue(
      JSON.stringify({
        allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      }),
    );
    // realpathSync: first call for the mount path, second for allowedRoot
    mockFs.realpathSync = vi
      .fn()
      .mockReturnValueOnce('/home/user/.ssh') // mount realpath
      .mockReturnValueOnce('/home/user/projects'); // root realpath

    const { validateMount } = await makeValidateMount();
    const result = validateMount({ hostPath: '/home/user/.ssh' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('does NOT block a path that only contains the pattern as a substring', async () => {
    // ".aws" should NOT block "/home/user/.awsome"
    mockFs.existsSync = vi.fn().mockReturnValue(true);
    mockFs.readFileSync = vi.fn().mockReturnValue(
      JSON.stringify({
        allowedRoots: [{ path: '/home/user', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      }),
    );
    mockFs.realpathSync = vi
      .fn()
      .mockReturnValueOnce('/home/user/.awsome') // mount realpath
      .mockReturnValueOnce('/home/user'); // root realpath

    const { validateMount } = await makeValidateMount();
    // .aws is in DEFAULT_BLOCKED_PATTERNS but .awsome should NOT match
    const result = validateMount({ hostPath: '/home/user/.awsome' }, true);
    // The path component is ".awsome" which does NOT equal ".aws"
    expect(result.allowed).toBe(true);
  });

  it('blocks path with .aws directory component', async () => {
    mockFs.existsSync = vi.fn().mockReturnValue(true);
    mockFs.readFileSync = vi.fn().mockReturnValue(
      JSON.stringify({
        allowedRoots: [{ path: '/home/user', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      }),
    );
    mockFs.realpathSync = vi
      .fn()
      .mockReturnValueOnce('/home/user/.aws/credentials') // mount realpath
      .mockReturnValueOnce('/home/user'); // root realpath

    const { validateMount } = await makeValidateMount();
    const result = validateMount({ hostPath: '/home/user/.aws/credentials' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.aws');
  });

  it('blocks path when no allowlist file exists', async () => {
    mockFs.existsSync = vi.fn().mockReturnValue(false);

    const { validateMount } = await makeValidateMount();
    const result = validateMount({ hostPath: '/home/user/project' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist');
  });
});
