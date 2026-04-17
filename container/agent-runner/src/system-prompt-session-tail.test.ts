import { describe, expect, it, vi } from 'vitest';

import { runSessionTail } from './system-prompt.js';
import { createMockDeps } from './system-prompt-test-harness.js';

const workspaceGroup = '/workspace/group';

describe('runSessionTail', () => {
  it('returns stdout from successful subprocess execution', async () => {
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess: vi.fn().mockResolvedValue('session tail output'),
    });

    const result = await runSessionTail(deps, workspaceGroup);
    expect(result).toBe('session tail output');
  });

  it('returns null and logs when session-tail.py does not exist', async () => {
    const log = vi.fn();
    const deps = createMockDeps({
      readFile: vi.fn().mockReturnValue(null),
      log,
    });

    const result = await runSessionTail(deps, workspaceGroup);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipped'));
  });

  it('returns null and logs when subprocess returns error', async () => {
    const log = vi.fn();
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess: vi.fn().mockRejectedValue(new Error('exit code 1')),
      log,
    });

    const result = await runSessionTail(deps, workspaceGroup);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('returns null and logs when stdout is empty', async () => {
    const log = vi.fn();
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess: vi.fn().mockResolvedValue(''),
      log,
    });

    const result = await runSessionTail(deps, workspaceGroup);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('empty'));
  });

  it('passes correct arguments and environment', async () => {
    const execSubprocess = vi.fn().mockResolvedValue('output');
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess,
    });

    await runSessionTail(deps, workspaceGroup);

    expect(execSubprocess).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining(['--last', '12', '--no-trim']),
      expect.objectContaining({ NANOCLAW_GROUP_DIR: workspaceGroup }),
      expect.any(Number),
    );
  });

  it('uses SESSION_TAIL_LINES env to change line count', async () => {
    const execSubprocess = vi.fn().mockResolvedValue('output');
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess,
    });

    await runSessionTail(deps, workspaceGroup, 30);

    expect(execSubprocess).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining(['--last', '30', '--no-trim']),
      expect.objectContaining({ NANOCLAW_GROUP_DIR: workspaceGroup }),
      expect.any(Number),
    );
  });

  it('defaults to 12 lines when no lines argument provided', async () => {
    const execSubprocess = vi.fn().mockResolvedValue('output');
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess,
    });

    await runSessionTail(deps, workspaceGroup);

    expect(execSubprocess).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining(['--last', '12', '--no-trim']),
      expect.any(Object),
      expect.any(Number),
    );
  });
});
