import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { refreshGmailTokens } from './gmail-token-refresh.js';

describe('refreshGmailTokens', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves with status="ok" on exit code 0', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '[OK] personal: refreshed\n', '');
      },
    );
    const result = await refreshGmailTokens();
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('personal');
  });

  it('resolves with status="missing" on exit code 2', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const err = Object.assign(new Error('Exit 2'), { code: 2 });
        cb(err, '[MISSING] attaxion: no credentials\n', '');
      },
    );
    const result = await refreshGmailTokens();
    expect(result.status).toBe('missing');
  });

  it('resolves with status="error" on exit code 3', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const err = Object.assign(new Error('Exit 3'), { code: 3 });
        cb(err, '[ERROR] personal: refresh failed\n', '');
      },
    );
    const result = await refreshGmailTokens();
    expect(result.status).toBe('error');
    expect(result.summary).toContain('refresh failed');
  });

  it('resolves with status="error" if the script itself crashes', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error('ENOENT'), '', '');
      },
    );
    const result = await refreshGmailTokens();
    expect(result.status).toBe('error');
  });

  it('maps execFile timeout (killed=true, signal=SIGTERM) to a timeout error', async () => {
    // Simulate how Node's execFile reports a timeout: after the configured
    // timeout elapses, execFile SIGTERMs the child and invokes the callback
    // with err.killed=true, err.signal='SIGTERM'. The wrapper should detect
    // that pattern and resolve as a timeout error, not a generic crash.
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const err = Object.assign(new Error('timeout'), {
          killed: true,
          signal: 'SIGTERM',
        });
        cb(err, '', '');
      },
    );
    const result = await refreshGmailTokens({ timeoutMs: 50 });
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/timeout|timed out/i);
  });

  it('also maps SIGTERM with killed=false to a timeout error (older Node)', async () => {
    // Defensive: some Node versions set signal='SIGTERM' without setting
    // killed=true on the error. The wrapper's check uses OR, so either
    // condition maps to the timeout result.
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const err = Object.assign(new Error('timeout'), {
          signal: 'SIGTERM',
        });
        cb(err, '', '');
      },
    );
    const result = await refreshGmailTokens({ timeoutMs: 50 });
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/timeout|timed out/i);
  });
});
