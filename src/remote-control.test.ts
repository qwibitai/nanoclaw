import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// テスト対象モジュールをインポートする前に config をモック化
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-rc-test',
}));

// child_process をモック化
const spawnMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

import {
  startRemoteControl,
  stopRemoteControl,
  restoreRemoteControl,
  getActiveSession,
  _resetForTesting,
  _getStateFilePath,
} from './remote-control.js';

// --- ヘルパー ---

function createMockProcess(pid = 12345) {
  return {
    pid,
    unref: vi.fn(),
    kill: vi.fn(),
    stdin: { write: vi.fn(), end: vi.fn() },
  };
}

describe('remote-control', () => {
  const STATE_FILE = _getStateFilePath();
  let readFileSyncSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSyncSpy: ReturnType<typeof vi.spyOn>;
  let unlinkSyncSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSyncSpy: ReturnType<typeof vi.spyOn>;
  let openSyncSpy: ReturnType<typeof vi.spyOn>;
  let closeSyncSpy: ReturnType<typeof vi.spyOn>;

  // readFileSync が stdout ファイルに対して返すべき内容を追跡する
  let stdoutFileContent: string;

  beforeEach(() => {
    _resetForTesting();
    spawnMock.mockReset();
    stdoutFileContent = '';

    // デフォルトの fs モック
    mkdirSyncSpy = vi
      .spyOn(fs, 'mkdirSync')
      .mockImplementation(() => undefined as any);
    writeFileSyncSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => {});
    unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    openSyncSpy = vi.spyOn(fs, 'openSync').mockReturnValue(42 as any);
    closeSyncSpy = vi.spyOn(fs, 'closeSync').mockImplementation(() => {});

    // readFileSync: stdout ファイルや状態ファイルなどに対して stdoutFileContent を返す
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      p: string,
    ) => {
      if (p.endsWith('remote-control.stdout')) return stdoutFileContent;
      if (p.endsWith('remote-control.json')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return '';
    }) as any);
  });

  afterEach(() => {
    _resetForTesting();
    vi.restoreAllMocks();
  });

  // --- startRemoteControl のテスト ---

  describe('startRemoteControl', () => {
    it('spawns claude remote-control and returns the URL', async () => {
      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);

      // 最初のポーリングで stdout ファイルに URL が出現するのをシミュレート
      stdoutFileContent =
        'Session URL: https://claude.ai/code?bridge=env_abc123\n';
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
      stdoutFileContent = 'https://claude.ai/code?bridge=env_test\n';
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');

      const spawnCall = spawnMock.mock.calls[0];
      const options = spawnCall[2];
      // stdio[0] は 'pipe' なので、プロンプトに 'y' を書き込める
      expect(options.stdio[0]).toBe('pipe');
      expect(typeof options.stdio[1]).toBe('number');
      expect(typeof options.stdio[2]).toBe('number');
    });

    it('closes file descriptors in parent after spawn', async () => {
      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_test\n';
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');

      // openSync が2回（stdout + stderr）、closeSync が2回呼ばれる
      expect(openSyncSpy).toHaveBeenCalledTimes(2);
      expect(closeSyncSpy).toHaveBeenCalledTimes(2);
    });

    it('saves state to disk after capturing URL', async () => {
      const proc = createMockProcess(99999);
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_save\n';
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');

      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        STATE_FILE,
        expect.stringContaining('"pid":99999'),
      );
    });

    it('returns existing URL if session is already active', async () => {
      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_existing\n';
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');

      // 2回目の呼び出しでは、新規起動せずに既存の URL を返すべき
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

      // 最初の起動: プロセスは生存、URL が見つかる
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((() => true) as any);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_first\n';
      await startRemoteControl('user1', 'tg:123', '/project');

      // 古いプロセス（11111）は終了、新しいプロセス（22222）は生存
      killSpy.mockImplementation(((pid: number, sig: any) => {
        if (pid === 11111 && (sig === 0 || sig === undefined)) {
          throw new Error('ESRCH');
        }
        return true;
      }) as any);

      stdoutFileContent = 'https://claude.ai/code?bridge=env_second\n';
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
      stdoutFileContent = '';

      // プロセスは終了している（ポーリングで検出される）
      vi.spyOn(process, 'kill').mockImplementation((() => {
        throw new Error('ESRCH');
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
      stdoutFileContent = 'no url here';
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      const promise = startRemoteControl('user1', 'tg:123', '/project');

      // URL_TIMEOUT_MS（30秒）を超過するまで、十分なポーリング回数で進める
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
      expect(result).toEqual({
        ok: false,
        error: 'Failed to start: ENOENT',
      });
    });
  });

  // --- stopRemoteControl のテスト ---

  describe('stopRemoteControl', () => {
    it('kills the process and clears state', async () => {
      const proc = createMockProcess(55555);
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_stop\n';
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');

      const result = stopRemoteControl();
      expect(result).toEqual({ ok: true });
      expect(killSpy).toHaveBeenCalledWith(55555, 'SIGTERM');
      expect(unlinkSyncSpy).toHaveBeenCalledWith(STATE_FILE);
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

  // --- restoreRemoteControl のテスト ---

  describe('restoreRemoteControl', () => {
    it('restores session if state file exists and process is alive', () => {
      const session = {
        pid: 77777,
        url: 'https://claude.ai/code?bridge=env_restored',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return JSON.stringify(session);
        return '';
      }) as any);
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
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return JSON.stringify(session);
        return '';
      }) as any);
      vi.spyOn(process, 'kill').mockImplementation((() => {
        throw new Error('ESRCH');
      }) as any);

      restoreRemoteControl();

      expect(getActiveSession()).toBeNull();
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it('does nothing if no state file exists', () => {
      // readFileSyncSpy はデフォルトで .json に対して ENOENT を投げる
      restoreRemoteControl();
      expect(getActiveSession()).toBeNull();
    });

    it('clears state on corrupted JSON', () => {
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return 'not json{{{';
        return '';
      }) as any);

      restoreRemoteControl();

      expect(getActiveSession()).toBeNull();
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    // ** これは重要な統合テスト: restore → stop が必ず動作すること **
    it('stopRemoteControl works after restoreRemoteControl', () => {
      const session = {
        pid: 77777,
        url: 'https://claude.ai/code?bridge=env_restored',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return JSON.stringify(session);
        return '';
      }) as any);
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((() => true) as any);

      restoreRemoteControl();
      expect(getActiveSession()).not.toBeNull();

      const result = stopRemoteControl();
      expect(result).toEqual({ ok: true });
      expect(killSpy).toHaveBeenCalledWith(77777, 'SIGTERM');
      expect(unlinkSyncSpy).toHaveBeenCalled();
      expect(getActiveSession()).toBeNull();
    });

    it('startRemoteControl returns restored URL without spawning', () => {
      const session = {
        pid: 77777,
        url: 'https://claude.ai/code?bridge=env_restored',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return JSON.stringify(session);
        return '';
      }) as any);
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      restoreRemoteControl();

      return startRemoteControl('user2', 'tg:456', '/project').then(
        (result) => {
          expect(result).toEqual({
            ok: true,
            url: 'https://claude.ai/code?bridge=env_restored',
          });
          expect(spawnMock).not.toHaveBeenCalled();
        },
      );
    });
  });
});
