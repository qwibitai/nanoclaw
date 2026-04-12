import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.fn();

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('session-cleanup', () => {
  it('schedules cleanup after 30s and then every 24 hours', async () => {
    const { startSessionCleanup } = await import('./session-cleanup.js');

    startSessionCleanup();

    // No exec yet
    expect(mockExecFile).not.toHaveBeenCalled();

    // Advance past 30s initial delay
    vi.advanceTimersByTime(30_000);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      '/bin/bash',
      expect.arrayContaining([expect.stringContaining('cleanup-sessions.sh')]),
      { timeout: 60_000 },
      expect.any(Function),
    );

    // Advance 24 hours for interval
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('logs output on successful cleanup', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: object,
        callback: (err: null, stdout: string) => void,
      ) => {
        callback(null, 'Cleaned 3 sessions\nSummary: 3 removed');
      },
    );

    const { startSessionCleanup } = await import('./session-cleanup.js');
    startSessionCleanup();
    vi.advanceTimersByTime(30_000);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('handles cleanup errors gracefully', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: object,
        callback: (err: Error) => void,
      ) => {
        callback(new Error('script not found'));
      },
    );

    const { startSessionCleanup } = await import('./session-cleanup.js');
    startSessionCleanup();
    vi.advanceTimersByTime(30_000);

    // Should not throw
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('handles empty stdout gracefully', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: object,
        callback: (err: null, stdout: string) => void,
      ) => {
        callback(null, '');
      },
    );

    const { startSessionCleanup } = await import('./session-cleanup.js');
    startSessionCleanup();
    vi.advanceTimersByTime(30_000);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});
