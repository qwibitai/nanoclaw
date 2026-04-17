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
  startRemoteControl,
} from './remote-control.js';
import {
  createMockProcess,
  installRcFsSpies,
  type RcFsSpies,
} from './remote-control-test-harness.js';

describe('startRemoteControl', () => {
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

  it('spawns claude remote-control and returns the URL', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    fsSpies.setStdoutContent(
      'Session URL: https://claude.ai/code?bridge=env_abc123\n',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

    const result = await startRemoteControl('user1', 'tg:123', '/project');

    expect(result).toEqual({
      ok: true,
      url: 'https://claude.ai/code?bridge=env_abc123',
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      ['remote-control', '--name', 'NanoClaw Remote'],
      expect.objectContaining({ cwd: '/project', detached: true }),
    );
    expect(proc.unref).toHaveBeenCalled();
  });

  it('uses file descriptors for stdout/stderr (not pipes)', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    fsSpies.setStdoutContent('https://claude.ai/code?bridge=env_test\n');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

    await startRemoteControl('user1', 'tg:123', '/project');

    const options = spawnMock.mock.calls[0][2];
    expect(options.stdio[0]).toBe('pipe');
    expect(typeof options.stdio[1]).toBe('number');
    expect(typeof options.stdio[2]).toBe('number');
  });

  it('closes file descriptors in parent after spawn', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    fsSpies.setStdoutContent('https://claude.ai/code?bridge=env_test\n');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

    await startRemoteControl('user1', 'tg:123', '/project');

    expect(fsSpies.openSync).toHaveBeenCalledTimes(2);
    expect(fsSpies.closeSync).toHaveBeenCalledTimes(2);
  });

  it('saves state to disk after capturing URL', async () => {
    const proc = createMockProcess(99999);
    spawnMock.mockReturnValue(proc);
    fsSpies.setStdoutContent('https://claude.ai/code?bridge=env_save\n');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

    await startRemoteControl('user1', 'tg:123', '/project');

    expect(fsSpies.writeFileSync).toHaveBeenCalledWith(
      STATE_FILE,
      expect.stringContaining('"pid":99999'),
    );
  });

  it('returns existing URL if session is already active', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    fsSpies.setStdoutContent('https://claude.ai/code?bridge=env_existing\n');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

    await startRemoteControl('user1', 'tg:123', '/project');

    const result = await startRemoteControl('user2', 'tg:456', '/project');
    expect(result).toEqual({
      ok: true,
      url: 'https://claude.ai/code?bridge=env_existing',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('starts new session if existing process is dead', async () => {
    const proc1 = createMockProcess(11111);
    const proc2 = createMockProcess(22222);
    spawnMock.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

    const killSpy = vi
      .spyOn(process, 'kill')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((() => true) as any);
    fsSpies.setStdoutContent('https://claude.ai/code?bridge=env_first\n');
    await startRemoteControl('user1', 'tg:123', '/project');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    killSpy.mockImplementation(((pid: number, sig: any) => {
      if (pid === 11111 && (sig === 0 || sig === undefined)) {
        throw new Error('ESRCH');
      }
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    fsSpies.setStdoutContent('https://claude.ai/code?bridge=env_second\n');
    const result = await startRemoteControl('user1', 'tg:123', '/project');

    expect(result).toEqual({
      ok: true,
      url: 'https://claude.ai/code?bridge=env_second',
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('returns error if process exits before URL', async () => {
    const proc = createMockProcess(33333);
    spawnMock.mockReturnValue(proc);
    fsSpies.setStdoutContent('');
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('ESRCH');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    const result = await startRemoteControl('user1', 'tg:123', '/project');
    expect(result).toEqual({
      ok: false,
      error: 'Process exited before producing URL',
    });
  });

  it('times out if URL never appears', async () => {
    vi.useFakeTimers();
    const proc = createMockProcess(44444);
    spawnMock.mockReturnValue(proc);
    fsSpies.setStdoutContent('no url here');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

    const promise = startRemoteControl('user1', 'tg:123', '/project');
    for (let i = 0; i < 160; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }
    const result = await promise;
    expect(result).toEqual({
      ok: false,
      error: 'Timed out waiting for Remote Control URL',
    });

    vi.useRealTimers();
  });

  it('returns error if spawn throws', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = await startRemoteControl('user1', 'tg:123', '/project');
    expect(result).toEqual({ ok: false, error: 'Failed to start: ENOENT' });
  });
});
