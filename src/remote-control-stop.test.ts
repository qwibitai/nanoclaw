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
  _getStateFilePath,
  _resetForTesting,
  getActiveSession,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  createMockProcess,
  installRcFsSpies,
  type RcFsSpies,
} from './remote-control-test-harness.js';

describe('stopRemoteControl', () => {
  const STATE_FILE = _getStateFilePath();
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

  it('kills the process and clears state', async () => {
    const proc = createMockProcess(55555);
    spawnMock.mockReturnValue(proc);
    fsSpies.setStdoutContent('https://claude.ai/code?bridge=env_stop\n');
    const killSpy = vi
      .spyOn(process, 'kill')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((() => true) as any);

    await startRemoteControl('user1', 'tg:123', '/project');

    const result = stopRemoteControl();
    expect(result).toEqual({ ok: true });
    expect(killSpy).toHaveBeenCalledWith(55555, 'SIGTERM');
    expect(fsSpies.unlinkSync).toHaveBeenCalledWith(STATE_FILE);
    expect(getActiveSession()).toBeNull();
  });

  it('returns error when no session is active', () => {
    const result = stopRemoteControl();
    expect(result).toEqual({
      ok: false,
      error: 'No active Remote Control session',
    });
  });
});
