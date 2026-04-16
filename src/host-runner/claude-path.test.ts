import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.fn<(cmd: string, opts?: unknown) => string>();
const existsSyncMock = vi.fn<(p: string) => boolean>();

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>(
    'child_process',
  );
  return { ...actual, execSync: execSyncMock };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: { ...actual, existsSync: existsSyncMock } };
});

describe('findClaudePath', () => {
  const origHome = process.env.HOME;

  beforeEach(async () => {
    execSyncMock.mockReset();
    existsSyncMock.mockReset();
    vi.resetModules();
    const mod = await import('./claude-path.js');
    mod._resetClaudePathCache();
  });

  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
  });

  it('returns the first existing candidate without spawning', async () => {
    process.env.HOME = '/home/alice';
    existsSyncMock.mockImplementation(
      (p) => String(p) === '/home/alice/.local/bin/claude',
    );
    const { findClaudePath } = await import('./claude-path.js');
    expect(findClaudePath()).toBe('/home/alice/.local/bin/claude');
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(existsSyncMock).toHaveBeenCalled();
  });

  it('falls back to `which claude` when no candidate exists', async () => {
    existsSyncMock.mockReturnValue(false);
    execSyncMock.mockReturnValue('/opt/homebrew/bin/claude\n');
    const { findClaudePath } = await import('./claude-path.js');
    expect(findClaudePath()).toBe('/opt/homebrew/bin/claude');
    expect(execSyncMock).toHaveBeenCalled();
  });

  it('returns empty string when `which claude` fails', async () => {
    existsSyncMock.mockReturnValue(false);
    execSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    const { findClaudePath } = await import('./claude-path.js');
    expect(findClaudePath()).toBe('');
  });

  it('memoizes the result across calls', async () => {
    existsSyncMock.mockReturnValue(false);
    execSyncMock.mockReturnValue('/usr/local/bin/claude\n');
    const { findClaudePath } = await import('./claude-path.js');
    findClaudePath();
    findClaudePath();
    findClaudePath();
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });
});
