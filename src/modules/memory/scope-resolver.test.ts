import fs from 'fs';
import path from 'path';
import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveRecallScope, clearScopeCacheForTest, setGroupsDirForTest } from './scope-resolver.js';

function makeTempGroupsDir(
  groups: Array<{ folder: string; agentGroupId?: string; memoryEnabled?: boolean }>,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-resolver-test-'));
  for (const g of groups) {
    const groupDir = path.join(dir, g.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    const cfg: Record<string, unknown> = {};
    if (g.agentGroupId !== undefined) cfg.agentGroupId = g.agentGroupId;
    if (g.memoryEnabled !== undefined) cfg.memory = { enabled: g.memoryEnabled };
    fs.writeFileSync(path.join(groupDir, 'container.json'), JSON.stringify(cfg));
  }
  return dir;
}

describe('resolveRecallScope', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearScopeCacheForTest();
    setGroupsDirForTest(null);
  });

  afterEach(() => {
    clearScopeCacheForTest();
    setGroupsDirForTest(null);
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('test_self_returns_single', () => {
    const result = resolveRecallScope('g1', 'self');
    expect(result).toEqual(['g1']);
  });

  it('test_all_groups_enumerates', () => {
    tmpDir = makeTempGroupsDir([
      { folder: 'group-a', agentGroupId: 'g1', memoryEnabled: true },
      { folder: 'group-b', agentGroupId: 'g2', memoryEnabled: true },
      { folder: 'group-c', agentGroupId: 'g3', memoryEnabled: false },
    ]);
    setGroupsDirForTest(tmpDir);

    const result = resolveRecallScope('g1', 'all-groups');

    expect(result).toContain('g1');
    expect(result).toContain('g2');
    expect(result).not.toContain('g3');
    expect(result.filter((id) => id === 'g1')).toHaveLength(1); // no duplicates
  });

  it('test_array_resolves_folder_names', () => {
    tmpDir = makeTempGroupsDir([
      { folder: 'axie-dev', agentGroupId: 'ag-axie-dev-123', memoryEnabled: true },
    ]);
    setGroupsDirForTest(tmpDir);

    const result = resolveRecallScope('g1', ['axie-dev']);

    expect(result).toEqual(expect.arrayContaining(['g1', 'ag-axie-dev-123']));
    expect(result[0]).toBe('g1'); // calling group first
  });

  it('test_array_drops_missing_folder', () => {
    tmpDir = makeTempGroupsDir([]);
    setGroupsDirForTest(tmpDir);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = resolveRecallScope('g1', ['nonexistent']);

    expect(result).toEqual(['g1']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
    warnSpy.mockRestore();
  });

  it('test_cache_amortizes_fs_reads', () => {
    tmpDir = makeTempGroupsDir([
      { folder: 'group-a', agentGroupId: 'g1', memoryEnabled: true },
    ]);
    setGroupsDirForTest(tmpDir);

    const readSpy = vi.spyOn(fs, 'readFileSync');
    clearScopeCacheForTest();

    resolveRecallScope('g1', 'all-groups');
    const countAfterFirst = readSpy.mock.calls.length;

    resolveRecallScope('g1', 'all-groups');
    const countAfterSecond = readSpy.mock.calls.length;

    // Second call should be a cache hit — no additional readFileSync calls
    expect(countAfterSecond).toBe(countAfterFirst);

    readSpy.mockRestore();
  });

  it('test_dedupes_calling_group', () => {
    tmpDir = makeTempGroupsDir([
      { folder: 'group-a', agentGroupId: 'g1', memoryEnabled: true },
    ]);
    setGroupsDirForTest(tmpDir);

    const result = resolveRecallScope('g1', 'all-groups');

    // g1 is both the calling group and the only memory-enabled group — must appear once
    expect(result.filter((id) => id === 'g1')).toHaveLength(1);
  });
});
