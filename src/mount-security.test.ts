import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('pino', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { default: () => mockLogger };
});

// Mock config
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/mock/config/mount-allowlist.json',
}));

// Mock fs — store the mock fns so tests can configure them
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();
vi.mock('fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
  },
}));

import {
  _resetMountCacheForTests,
  generateAllowlistTemplate,
  loadMountAllowlist,
  validateAdditionalMounts,
  validateMount,
} from './mount-security.js';

// Helper: build a valid allowlist JSON string
function makeAllowlist(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    allowedRoots: [
      {
        path: '/allowed/projects',
        allowReadWrite: true,
        description: 'Projects',
      },
      {
        path: '/allowed/readonly',
        allowReadWrite: false,
        description: 'Read-only docs',
      },
    ],
    blockedPatterns: ['custom-secret'],
    nonMainReadOnly: true,
    ...overrides,
  });
}

// Make realpathSync return the input by default (no symlinks)
function setupRealpathPassthrough() {
  mockRealpathSync.mockImplementation((p: string) => p);
}

// Configure a valid allowlist on disk
function setupValidAllowlist(overrides: Record<string, unknown> = {}) {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(makeAllowlist(overrides));
  setupRealpathPassthrough();
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetMountCacheForTests();
});

// --- loadMountAllowlist ---

describe('loadMountAllowlist', () => {
  it('returns null when allowlist file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when file contains invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json {{{');

    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when allowedRoots is missing', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ blockedPatterns: [], nonMainReadOnly: true }),
    );

    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when blockedPatterns is not an array', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: 'not-array',
        nonMainReadOnly: true,
      }),
    );

    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when nonMainReadOnly is not a boolean', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: 'yes',
      }),
    );

    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('merges default blocked patterns with user patterns', () => {
    setupValidAllowlist();

    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    // Should contain both default patterns and user patterns
    expect(result!.blockedPatterns).toContain('.ssh');
    expect(result!.blockedPatterns).toContain('.aws');
    expect(result!.blockedPatterns).toContain('.env');
    expect(result!.blockedPatterns).toContain('custom-secret');
  });

  it('caches result on second call', () => {
    setupValidAllowlist();

    const first = loadMountAllowlist();
    const second = loadMountAllowlist();
    expect(first).toBe(second); // Same reference
    // readFileSync should only be called once
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('caches error on failed load and does not retry', () => {
    mockExistsSync.mockReturnValue(false);

    const first = loadMountAllowlist();
    expect(first).toBeNull();

    // Even if the file now exists, cached error prevents reload
    mockExistsSync.mockReturnValue(true);
    const second = loadMountAllowlist();
    expect(second).toBeNull();
  });
});

// --- validateMount ---

describe('validateMount', () => {
  it('blocks all mounts when no allowlist is configured', () => {
    mockExistsSync.mockReturnValue(false);

    const result = validateMount(
      { hostPath: '/some/path', readonly: true },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist configured');
  });

  it('rejects non-existent host paths', () => {
    setupValidAllowlist();
    // realpathSync throws for non-existent paths
    mockRealpathSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = validateMount(
      { hostPath: '/does/not/exist', readonly: true },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('rejects paths matching default blocked patterns', () => {
    setupValidAllowlist();

    const result = validateMount(
      { hostPath: '/allowed/projects/.ssh', readonly: true },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('rejects paths matching user-defined blocked patterns', () => {
    setupValidAllowlist();

    const result = validateMount(
      { hostPath: '/allowed/projects/custom-secret', readonly: true },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('custom-secret');
  });

  it('rejects paths containing blocked pattern as substring', () => {
    setupValidAllowlist();

    // A directory named "my-credentials-backup" contains the "credentials" pattern
    const result = validateMount(
      { hostPath: '/allowed/projects/my-credentials-backup', readonly: true },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('credentials');
  });

  it('rejects paths not under any allowed root', () => {
    setupValidAllowlist();

    const result = validateMount(
      { hostPath: '/not/allowed/path', readonly: true },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('allows paths under an allowed root', () => {
    setupValidAllowlist();

    const result = validateMount(
      { hostPath: '/allowed/projects/myapp', readonly: true },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe('/allowed/projects/myapp');
    expect(result.effectiveReadonly).toBe(true);
  });

  it('derives containerPath from hostPath basename when not specified', () => {
    setupValidAllowlist();

    const result = validateMount({ hostPath: '/allowed/projects/myapp' }, true);
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('myapp');
  });

  it('uses explicit containerPath when specified', () => {
    setupValidAllowlist();

    const result = validateMount(
      { hostPath: '/allowed/projects/myapp', containerPath: 'custom-name' },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('custom-name');
  });

  // --- Container path validation ---

  it('rejects container paths containing ".."', () => {
    setupValidAllowlist();

    const result = validateMount(
      {
        hostPath: '/allowed/projects/myapp',
        containerPath: '../escape',
      },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('..');
  });

  it('rejects absolute container paths', () => {
    setupValidAllowlist();

    const result = validateMount(
      {
        hostPath: '/allowed/projects/myapp',
        containerPath: '/absolute/path',
      },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('must be relative');
  });

  it('falls back to basename when containerPath is empty string', () => {
    setupValidAllowlist();

    // Empty string is falsy, so || falls through to path.basename
    const result = validateMount(
      {
        hostPath: '/allowed/projects/myapp',
        containerPath: '',
      },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('myapp');
  });

  it('rejects whitespace-only container paths', () => {
    setupValidAllowlist();

    const result = validateMount(
      {
        hostPath: '/allowed/projects/myapp',
        containerPath: '   ',
      },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('non-empty');
  });

  // --- Read-only enforcement ---

  it('enforces read-only for non-main groups when nonMainReadOnly is true', () => {
    setupValidAllowlist({ nonMainReadOnly: true });

    const result = validateMount(
      { hostPath: '/allowed/projects/myapp', readonly: false },
      false, // non-main
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows read-write for main group even when nonMainReadOnly is true', () => {
    setupValidAllowlist({ nonMainReadOnly: true });

    const result = validateMount(
      { hostPath: '/allowed/projects/myapp', readonly: false },
      true, // main
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('enforces read-only when allowed root does not permit read-write', () => {
    setupValidAllowlist();

    // /allowed/readonly has allowReadWrite: false
    const result = validateMount(
      { hostPath: '/allowed/readonly/docs', readonly: false },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('defaults to read-only when mount.readonly is not explicitly false', () => {
    setupValidAllowlist();

    const result = validateMount({ hostPath: '/allowed/projects/myapp' }, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows non-main group read-write when nonMainReadOnly is false', () => {
    setupValidAllowlist({ nonMainReadOnly: false });

    const result = validateMount(
      { hostPath: '/allowed/projects/myapp', readonly: false },
      false, // non-main
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  // --- Symlink resolution ---

  it('resolves symlinks and validates against real path', () => {
    setupValidAllowlist();
    // Symlink /symlink/project → /allowed/projects/myapp
    mockRealpathSync.mockImplementation((p: string) => {
      if (p === '/symlink/project') return '/allowed/projects/myapp';
      return p;
    });

    const result = validateMount(
      { hostPath: '/symlink/project', readonly: true },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe('/allowed/projects/myapp');
  });

  it('blocks symlinks that resolve outside allowed roots', () => {
    setupValidAllowlist();
    // Symlink /allowed/projects/sneaky → /etc/passwd
    mockRealpathSync.mockImplementation((p: string) => {
      if (p === '/allowed/projects/sneaky') return '/etc/passwd';
      return p;
    });

    const result = validateMount(
      { hostPath: '/allowed/projects/sneaky', readonly: true },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('blocks symlinks that resolve to blocked paths', () => {
    setupValidAllowlist();
    // Symlink /allowed/projects/link → /allowed/projects/.ssh/keys
    mockRealpathSync.mockImplementation((p: string) => {
      if (p === '/allowed/projects/link') return '/allowed/projects/.ssh/keys';
      return p;
    });

    const result = validateMount(
      { hostPath: '/allowed/projects/link', readonly: true },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });
});

// --- validateAdditionalMounts ---

describe('validateAdditionalMounts', () => {
  it('returns only valid mounts from a mixed list', () => {
    setupValidAllowlist();

    const mounts = [
      { hostPath: '/allowed/projects/app1', readonly: true },
      { hostPath: '/not/allowed/path', readonly: true },
      { hostPath: '/allowed/projects/app2', readonly: true },
    ];

    const result = validateAdditionalMounts(mounts, 'test-group', true);
    expect(result).toHaveLength(2);
    expect(result[0].hostPath).toBe('/allowed/projects/app1');
    expect(result[1].hostPath).toBe('/allowed/projects/app2');
  });

  it('prefixes container paths with /workspace/extra/', () => {
    setupValidAllowlist();

    const mounts = [
      {
        hostPath: '/allowed/projects/myapp',
        containerPath: 'myapp',
        readonly: true,
      },
    ];

    const result = validateAdditionalMounts(mounts, 'test-group', true);
    expect(result).toHaveLength(1);
    expect(result[0].containerPath).toBe('/workspace/extra/myapp');
  });

  it('returns empty array when all mounts are rejected', () => {
    setupValidAllowlist();

    const mounts = [
      { hostPath: '/not/allowed/a', readonly: true },
      { hostPath: '/not/allowed/b', readonly: true },
    ];

    const result = validateAdditionalMounts(mounts, 'test-group', true);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    setupValidAllowlist();

    const result = validateAdditionalMounts([], 'test-group', true);
    expect(result).toHaveLength(0);
  });
});

// --- generateAllowlistTemplate ---

describe('generateAllowlistTemplate', () => {
  it('returns valid JSON', () => {
    const template = generateAllowlistTemplate();
    expect(() => JSON.parse(template)).not.toThrow();
  });

  it('includes required fields', () => {
    const parsed = JSON.parse(generateAllowlistTemplate());
    expect(parsed).toHaveProperty('allowedRoots');
    expect(parsed).toHaveProperty('blockedPatterns');
    expect(parsed).toHaveProperty('nonMainReadOnly');
    expect(Array.isArray(parsed.allowedRoots)).toBe(true);
    expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');
  });
});
