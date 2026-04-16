import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  _resetMountAllowlistCache,
  generateAllowlistTemplate,
  loadMountAllowlist,
  validateAdditionalMounts,
  validateMount,
} from './mount-security.js';
import type { MountAllowlist } from './types.js';

// Each test gets its own sandbox under mkdtempSync so concurrent runs
// can't collide and nothing leaks into the shared /tmp root.
let sandbox: string;
let ALLOWLIST: string;

vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    get MOUNT_ALLOWLIST_PATH() {
      return ALLOWLIST;
    },
  };
});

function writeAllowlist(contents: object | string): void {
  fs.writeFileSync(
    ALLOWLIST,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
}

function makeRealDir(rel: string): string {
  const p = path.join(sandbox, rel);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe('mount-security', () => {
  const origHome = process.env.HOME;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-sec-'));
    ALLOWLIST = path.join(sandbox, 'allowlist.json');
    _resetMountAllowlistCache();
    process.env.HOME = sandbox;
  });

  afterEach(() => {
    _resetMountAllowlistCache();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      /* ignore */
    }
  });

  describe('loadMountAllowlist', () => {
    it('returns null when the file does not exist', () => {
      expect(loadMountAllowlist()).toBeNull();
    });

    it('loads and merges default blocked patterns', () => {
      writeAllowlist({
        allowedRoots: [],
        blockedPatterns: ['custom-secret'],
        nonMainReadOnly: true,
      });
      const list = loadMountAllowlist();
      expect(list).not.toBeNull();
      expect(list!.blockedPatterns).toContain('custom-secret');
      expect(list!.blockedPatterns).toContain('.ssh'); // default
    });

    it('caches subsequent reads', () => {
      writeAllowlist({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const first = loadMountAllowlist();
      fs.unlinkSync(ALLOWLIST); // remove file
      const second = loadMountAllowlist();
      expect(second).toBe(first); // same cached object
    });

    it("caches parse errors so logs aren't spammed", () => {
      writeAllowlist('{ not-json');
      expect(loadMountAllowlist()).toBeNull();
      // Re-writing a valid file doesn't revive — error is cached.
      writeAllowlist({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      expect(loadMountAllowlist()).toBeNull();
    });

    it('rejects invalid structure (missing allowedRoots)', () => {
      writeAllowlist({ blockedPatterns: [], nonMainReadOnly: true });
      expect(loadMountAllowlist()).toBeNull();
    });

    it('rejects invalid structure (wrong nonMainReadOnly type)', () => {
      writeAllowlist({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: 'yes',
      } as unknown as MountAllowlist);
      expect(loadMountAllowlist()).toBeNull();
    });
  });

  describe('validateMount', () => {
    it('blocks all mounts when no allowlist is configured', () => {
      const result = validateMount(
        { hostPath: '/tmp', containerPath: 'tmp' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/No mount allowlist/);
    });

    it('rejects containerPath containing ".."', () => {
      writeAllowlist({
        allowedRoots: [{ path: sandbox, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: sandbox, containerPath: '../escape' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Invalid container path/);
    });

    it('rejects absolute containerPath', () => {
      writeAllowlist({
        allowedRoots: [{ path: sandbox, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: sandbox, containerPath: '/etc' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Invalid container path/);
    });

    it('rejects containerPath with colon (docker injection guard)', () => {
      writeAllowlist({
        allowedRoots: [{ path: sandbox, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: sandbox, containerPath: 'repo:rw' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Invalid container path/);
    });

    it('rejects non-existent host path', () => {
      writeAllowlist({
        allowedRoots: [{ path: sandbox, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: '/nonexistent/path/surely', containerPath: 'x' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/does not exist/);
    });

    it('rejects paths matching default blocked patterns', () => {
      const target = makeRealDir('test-ssh-block/.ssh');
      writeAllowlist({
        allowedRoots: [{ path: sandbox, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: target, containerPath: 'safe' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/blocked pattern/);
    });

    it('rejects paths outside every allowed root', () => {
      const target = makeRealDir('test-outside');
      writeAllowlist({
        allowedRoots: [{ path: '/nonexistent', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: target, containerPath: 'x' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/not under any allowed root/);
    });

    it('allows paths under an allowed root with read-write', () => {
      const root = makeRealDir('test-allowed-root');
      const child = makeRealDir('test-allowed-root/project');
      writeAllowlist({
        allowedRoots: [{ path: root, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: child, containerPath: 'project', readonly: false },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(false);
      expect(result.realHostPath).toBe(child);
    });

    it('forces read-only for non-main groups when nonMainReadOnly=true', () => {
      const root = makeRealDir('test-forced-ro');
      const child = makeRealDir('test-forced-ro/proj');
      writeAllowlist({
        allowedRoots: [{ path: root, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: true,
      });
      const result = validateMount(
        { hostPath: child, containerPath: 'proj', readonly: false },
        false, // isMain=false
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('forces read-only when the allowed root disallows read-write', () => {
      const root = makeRealDir('test-ro-root');
      const child = makeRealDir('test-ro-root/docs');
      writeAllowlist({
        allowedRoots: [{ path: root, allowReadWrite: false }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: child, containerPath: 'docs', readonly: false },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('defaults to read-only when readonly is undefined', () => {
      const root = makeRealDir('test-default-ro');
      const child = makeRealDir('test-default-ro/x');
      writeAllowlist({
        allowedRoots: [{ path: root, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: child, containerPath: 'x' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('expands ~ in the hostPath to the user home dir', () => {
      const real = makeRealDir('tilde-target');
      // The allowlist root uses ~ so we exercise expandPath on both sides
      writeAllowlist({
        allowedRoots: [
          { path: path.join('~', 'tilde-target'), allowReadWrite: true },
        ],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        {
          hostPath: path.join('~', 'tilde-target'),
          containerPath: 'tilde',
          readonly: false,
        },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.realHostPath).toBe(real);
    });

    it('derives containerPath from basename when omitted', () => {
      const root = makeRealDir('basename-root');
      const child = makeRealDir('basename-root/my-project');
      writeAllowlist({
        allowedRoots: [{ path: root, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount({ hostPath: child }, true);
      expect(result.allowed).toBe(true);
      expect(result.resolvedContainerPath).toBe('my-project');
    });
  });

  describe('validateAdditionalMounts', () => {
    it('returns only the mounts that passed validation', () => {
      const root = makeRealDir('multi-root');
      makeRealDir('multi-root/good');
      writeAllowlist({
        allowedRoots: [{ path: root, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateAdditionalMounts(
        [
          { hostPath: path.join(root, 'good'), containerPath: 'good' },
          { hostPath: '/nonexistent', containerPath: 'bad' },
        ],
        'test-group',
        true,
      );
      expect(result).toHaveLength(1);
      expect(result[0].containerPath).toBe('/workspace/extra/good');
      expect(result[0].readonly).toBe(true);
    });

    it('returns an empty array when every mount is rejected', () => {
      writeAllowlist({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateAdditionalMounts(
        [{ hostPath: '/nonexistent', containerPath: 'x' }],
        'g',
        true,
      );
      expect(result).toEqual([]);
    });
  });

  describe('generateAllowlistTemplate', () => {
    it('returns JSON with allowedRoots, blockedPatterns, and nonMainReadOnly', () => {
      const parsed = JSON.parse(generateAllowlistTemplate()) as MountAllowlist;
      expect(Array.isArray(parsed.allowedRoots)).toBe(true);
      expect(parsed.allowedRoots.length).toBeGreaterThan(0);
      expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
      expect(typeof parsed.nonMainReadOnly).toBe('boolean');
    });
  });
});
