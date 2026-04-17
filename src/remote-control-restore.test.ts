import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-rc-test',
}));

const spawnMock = vi.fn();
vi.mock('child_process', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawn: (...args: any[]) => spawnMock(...args),
}));

import {
  _resetForTesting,
  getActiveSession,
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  installRcFsSpies,
  type RcFsSpies,
} from './remote-control-test-harness.js';

describe('restoreRemoteControl', () => {
  let fsSpies: RcFsSpies;

  beforeEach(() => {
    _resetForTesting();
    spawnMock.mockReset();
    fsSpies = installRcFsSpies();
  });

  afterEach(() => {
    _resetForTesting();
    vi.restoreAllMocks();
  });

  it('restores session if state file exists and process is alive', () => {
    const session = {
      pid: 77777,
      url: 'https://claude.ai/code?bridge=env_restored',
      startedBy: 'user1',
      startedInChat: 'tg:123',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    fsSpies.readFileSync.mockImplementation(((p: string) => {
      if (p.endsWith('remote-control.json')) return JSON.stringify(session);
      return '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

    restoreRemoteControl();

    const active = getActiveSession();
    expect(active).not.toBeNull();
    expect(active!.pid).toBe(77777);
    expect(active!.url).toBe('https://claude.ai/code?bridge=env_restored');
  });

  it('clears state if process is dead', () => {
    const session = {
      pid: 88888,
      url: 'https://claude.ai/code?bridge=env_dead',
      startedBy: 'user1',
      startedInChat: 'tg:123',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    fsSpies.readFileSync.mockImplementation(((p: string) => {
      if (p.endsWith('remote-control.json')) return JSON.stringify(session);
      return '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('ESRCH');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    restoreRemoteControl();

    expect(getActiveSession()).toBeNull();
    expect(fsSpies.unlinkSync).toHaveBeenCalled();
  });

  it('does nothing if no state file exists', () => {
    restoreRemoteControl();
    expect(getActiveSession()).toBeNull();
  });

  it('clears state on corrupted JSON', () => {
    fsSpies.readFileSync.mockImplementation(((p: string) => {
      if (p.endsWith('remote-control.json')) return 'not json{{{';
      return '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    restoreRemoteControl();

    expect(getActiveSession()).toBeNull();
    expect(fsSpies.unlinkSync).toHaveBeenCalled();
  });

  it('stopRemoteControl works after restoreRemoteControl', () => {
    const session = {
      pid: 77777,
      url: 'https://claude.ai/code?bridge=env_restored',
      startedBy: 'user1',
      startedInChat: 'tg:123',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    fsSpies.readFileSync.mockImplementation(((p: string) => {
      if (p.endsWith('remote-control.json')) return JSON.stringify(session);
      return '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    const killSpy = vi
      .spyOn(process, 'kill')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((() => true) as any);

    restoreRemoteControl();
    expect(getActiveSession()).not.toBeNull();

    const result = stopRemoteControl();
    expect(result).toEqual({ ok: true });
    expect(killSpy).toHaveBeenCalledWith(77777, 'SIGTERM');
    expect(fsSpies.unlinkSync).toHaveBeenCalled();
    expect(getActiveSession()).toBeNull();
  });

  it('startRemoteControl returns restored URL without spawning', async () => {
    const session = {
      pid: 77777,
      url: 'https://claude.ai/code?bridge=env_restored',
      startedBy: 'user1',
      startedInChat: 'tg:123',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    fsSpies.readFileSync.mockImplementation(((p: string) => {
      if (p.endsWith('remote-control.json')) return JSON.stringify(session);
      return '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

    restoreRemoteControl();

    const result = await startRemoteControl('user2', 'tg:456', '/project');
    expect(result).toEqual({
      ok: true,
      url: 'https://claude.ai/code?bridge=env_restored',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
