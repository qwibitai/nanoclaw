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

  it('times out cleanly after the configured timeout', async () => {
    // execFile mock just never invokes the callback
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, _cb: Function) => {
        // never call cb — simulate hang
      },
    );
    const result = await refreshGmailTokens({ timeoutMs: 50 });
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/timeout|timed out/i);
  });
});
