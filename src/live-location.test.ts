import fs from 'fs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import {
  LiveLocationManager,
  LiveLocationManagerOpts,
  _setActiveLiveLocationManager,
  buildLocationPrefix,
  getActiveLiveLocationContext,
} from './live-location.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const LOG_DIR = '/tmp/test-location-logs';

function makeOpts(
  overrides?: Partial<LiveLocationManagerOpts>,
): LiveLocationManagerOpts {
  return {
    logDir: LOG_DIR,
    idleTimeoutMs: 300_000, // 5 min for tests
    onTimeout: vi.fn(),
    onStopped: vi.fn(),
    ...overrides,
  };
}

function makeManager(
  opts?: Partial<LiveLocationManagerOpts>,
): LiveLocationManager {
  return new LiveLocationManager(makeOpts(opts));
}

// ---------------------------------------------------------------------------
// buildLocationPrefix
// ---------------------------------------------------------------------------

describe('buildLocationPrefix', () => {
  it('includes all fields when provided', () => {
    const result = buildLocationPrefix(
      '[Live location sharing start]',
      35.6762,
      139.6503,
      '/path/to/log.log',
      10.5,
      180,
    );
    expect(result).toBe(
      '[Live location sharing start] lat: 35.6762, long: 139.6503, horizontal_accuracy: 10.5, heading: 180. check `tail /path/to/log.log`',
    );
  });

  it('omits optional fields when absent', () => {
    const result = buildLocationPrefix(
      '[Live location sharing enabled]',
      35.6762,
      139.6503,
      '/path/to/log.log',
    );
    expect(result).toBe(
      '[Live location sharing enabled] lat: 35.6762, long: 139.6503. check `tail /path/to/log.log`',
    );
  });

  it('includes only horizontal_accuracy when heading is absent', () => {
    const result = buildLocationPrefix(
      '[Live location sharing enabled]',
      1,
      2,
      '/log',
      50,
      undefined,
    );
    expect(result).toContain('horizontal_accuracy: 50');
    expect(result).not.toContain('heading');
  });

  it('includes only heading when horizontal_accuracy is absent', () => {
    const result = buildLocationPrefix(
      '[Live location sharing enabled]',
      1,
      2,
      '/log',
      undefined,
      90,
    );
    expect(result).toContain('heading: 90');
    expect(result).not.toContain('horizontal_accuracy');
  });
});

// ---------------------------------------------------------------------------
// LiveLocationManager — setup / file naming
// ---------------------------------------------------------------------------

describe('LiveLocationManager', () => {
  let mkdirSyncSpy: Mock;
  let appendFileSyncSpy: Mock;
  let statSyncSpy: Mock;
  let existsSyncSpy: Mock;
  let readdirSyncSpy: Mock;
  let renameSyncSpy: Mock;
  let unlinkSyncSpy: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined) as Mock;
    appendFileSyncSpy = vi
      .spyOn(fs, 'appendFileSync')
      .mockReturnValue(undefined) as Mock;
    statSyncSpy = vi
      .spyOn(fs, 'statSync')
      .mockReturnValue({ size: 0 } as fs.Stats) as Mock;
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false) as Mock;
    readdirSyncSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([]) as Mock;
    renameSyncSpy = vi
      .spyOn(fs, 'renameSync')
      .mockReturnValue(undefined) as Mock;
    unlinkSyncSpy = vi
      .spyOn(fs, 'unlinkSync')
      .mockReturnValue(undefined) as Mock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _setActiveLiveLocationManager(null);
  });

  // -------------------------------------------------------------------------
  // makeLogFilePath (via startSession return value)
  // -------------------------------------------------------------------------

  describe('log file path naming', () => {
    it('uses numeric chat id for positive ids', () => {
      const manager = makeManager();
      const logPath = manager.startSession('tg:99001', 42, 35, 139, 600);
      expect(logPath).toBe(`${LOG_DIR}/99001_42.log`);
    });

    it('replaces leading minus with underscore for negative ids', () => {
      const manager = makeManager();
      const logPath = manager.startSession(
        'tg:-1001234567890',
        12345,
        35,
        139,
        600,
      );
      expect(logPath).toBe(`${LOG_DIR}/_1001234567890_12345.log`);
    });
  });

  // -------------------------------------------------------------------------
  // computeTimeoutMs (tested via timeout behaviour)
  // -------------------------------------------------------------------------

  describe('timeout calculation', () => {
    it('uses min(livePeriod*1000, idleTimeoutMs) for normal live_period', () => {
      const onTimeout = vi.fn();
      const manager = makeManager({ idleTimeoutMs: 300_000, onTimeout });
      manager.startSession('tg:1', 1, 35, 139, 60); // 60s = 60000ms < 300000ms
      vi.advanceTimersByTime(60_001);
      expect(onTimeout).toHaveBeenCalledWith('tg:1');
    });

    it('caps at idleTimeoutMs when livePeriod*1000 exceeds it', () => {
      const onTimeout = vi.fn();
      const manager = makeManager({ idleTimeoutMs: 5_000, onTimeout });
      manager.startSession('tg:1', 1, 35, 139, 86400); // 24h, but cap at 5s
      vi.advanceTimersByTime(5_001);
      expect(onTimeout).toHaveBeenCalledWith('tg:1');
    });

    it('uses idleTimeoutMs for FOREVER (0x7FFFFFFF)', () => {
      const onTimeout = vi.fn();
      const manager = makeManager({ idleTimeoutMs: 5_000, onTimeout });
      manager.startSession('tg:1', 1, 35, 139, 0x7fffffff);
      vi.advanceTimersByTime(4_999);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(onTimeout).toHaveBeenCalledWith('tg:1');
    });

    it('uses idleTimeoutMs for live_period === 0', () => {
      const onTimeout = vi.fn();
      const manager = makeManager({ idleTimeoutMs: 5_000, onTimeout });
      manager.startSession('tg:1', 1, 35, 139, 0);
      vi.advanceTimersByTime(5_001);
      expect(onTimeout).toHaveBeenCalledWith('tg:1');
    });
  });

  // -------------------------------------------------------------------------
  // startSession
  // -------------------------------------------------------------------------

  describe('startSession', () => {
    it('creates dir, writes JSONL entry, returns log path', () => {
      const manager = makeManager();
      const logPath = manager.startSession('tg:100', 1, 35.6762, 139.6503, 600);

      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(LOG_DIR),
        { recursive: true },
      );
      expect(appendFileSyncSpy).toHaveBeenCalledOnce();
      const written = appendFileSyncSpy.mock.calls[0][1] as string;
      const entry = JSON.parse(written.trim());
      expect(entry.lat).toBe(35.6762);
      expect(entry.lng).toBe(139.6503);
      expect(entry.time).toBeDefined();
      expect(entry.horizontal_accuracy).toBeUndefined();
      expect(entry.heading).toBeUndefined();
      expect(logPath).toBe(`${LOG_DIR}/100_1.log`);
    });

    it('includes optional fields in JSONL when provided', () => {
      const manager = makeManager();
      manager.startSession('tg:100', 1, 35.6762, 139.6503, 600, 10.5, 180);
      const written = appendFileSyncSpy.mock.calls[0][1] as string;
      const entry = JSON.parse(written.trim());
      expect(entry.horizontal_accuracy).toBe(10.5);
      expect(entry.heading).toBe(180);
    });

    it('cancels previous session timer when starting a new session for same chat', () => {
      const onTimeout = vi.fn();
      const manager = makeManager({ idleTimeoutMs: 5_000, onTimeout });
      manager.startSession('tg:1', 1, 35, 139, 60); // 60s timer
      manager.startSession('tg:1', 2, 36, 140, 60); // replaces it
      vi.advanceTimersByTime(61_000);
      // Only one timeout fires (the new session's)
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // updateSession — normal update
  // -------------------------------------------------------------------------

  describe('updateSession / updated', () => {
    it('appends log entry and returns updated', () => {
      const manager = makeManager();
      manager.startSession('tg:1', 1, 35, 139, 600);
      appendFileSyncSpy.mockClear();

      const result = manager.updateSession('tg:1', 1, 36, 140);
      expect(result).toBe('updated');
      expect(appendFileSyncSpy).toHaveBeenCalledOnce();
    });

    it('resets idle timeout on update', () => {
      const onTimeout = vi.fn();
      const manager = makeManager({ idleTimeoutMs: 5_000, onTimeout });
      manager.startSession('tg:1', 1, 35, 139, 0x7fffffff);

      vi.advanceTimersByTime(4_000); // close but not timed out
      manager.updateSession('tg:1', 1, 36, 140); // resets timer

      vi.advanceTimersByTime(4_000); // 4s after reset, still within 5s
      expect(onTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_100); // now > 5s from last update
      expect(onTimeout).toHaveBeenCalledWith('tg:1');
    });

    it('updates latest position', () => {
      const manager = makeManager();
      manager.startSession('tg:1', 1, 35, 139, 600);
      manager.updateSession('tg:1', 1, 99, 45, 20, 270);

      const pos = manager.getLatestPosition('tg:1');
      expect(pos?.latestLat).toBe(99);
      expect(pos?.latestLng).toBe(45);
      expect(pos?.latestHorizontalAccuracy).toBe(20);
      expect(pos?.latestHeading).toBe(270);
    });
  });

  // -------------------------------------------------------------------------
  // updateSession — stopped (live_period === 0)
  // -------------------------------------------------------------------------

  describe('updateSession / stopped', () => {
    it('returns stopped and still appends final entry', () => {
      const manager = makeManager();
      manager.startSession('tg:1', 1, 35, 139, 600);
      appendFileSyncSpy.mockClear();

      const result = manager.updateSession(
        'tg:1',
        1,
        36,
        140,
        undefined,
        undefined,
        0,
      );
      expect(result).toBe('stopped');
      expect(appendFileSyncSpy).toHaveBeenCalledOnce();
    });

    it('clears the timeout so it does not fire after stopped', () => {
      const onTimeout = vi.fn();
      const manager = makeManager({ idleTimeoutMs: 5_000, onTimeout });
      manager.startSession('tg:1', 1, 35, 139, 0x7fffffff);

      manager.updateSession('tg:1', 1, 36, 140, undefined, undefined, 0);
      vi.advanceTimersByTime(10_000);
      expect(onTimeout).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // updateSession — recovery
  // -------------------------------------------------------------------------

  describe('updateSession / recovery-created', () => {
    it('creates recovery session when log file exists but no active session', () => {
      existsSyncSpy.mockReturnValue(true);
      const manager = makeManager();

      const result = manager.updateSession('tg:1', 5, 35, 139);
      expect(result).toBe('recovery-created');
      expect(appendFileSyncSpy).toHaveBeenCalledOnce();
      expect(manager.getLatestPosition('tg:1')).toBeDefined();
    });

    it('does NOT fire onTimeout when recovery session times out', () => {
      existsSyncSpy.mockReturnValue(true);
      const onTimeout = vi.fn();
      const manager = makeManager({ idleTimeoutMs: 1_000, onTimeout });
      manager.updateSession('tg:1', 5, 35, 139);

      vi.advanceTimersByTime(1_100);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('silently ignores update when no session and no log file', () => {
      existsSyncSpy.mockReturnValue(false);
      const manager = makeManager();

      const result = manager.updateSession('tg:2', 99, 35, 139);
      expect(result).toBe('updated'); // silent ignore returns 'updated'
      expect(appendFileSyncSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // stopSession
  // -------------------------------------------------------------------------

  describe('stopSession', () => {
    it('removes session, fires onStopped, getLatestPosition returns undefined', () => {
      const onStopped = vi.fn();
      const manager = makeManager({ onStopped });
      manager.startSession('tg:1', 1, 35, 139, 600);

      manager.stopSession('tg:1');

      expect(onStopped).toHaveBeenCalledWith('tg:1');
      expect(manager.getLatestPosition('tg:1')).toBeUndefined();
    });

    it('clears the timer so onTimeout does not fire', () => {
      const onTimeout = vi.fn();
      const manager = makeManager({ idleTimeoutMs: 1_000, onTimeout });
      manager.startSession('tg:1', 1, 35, 139, 0x7fffffff);

      manager.stopSession('tg:1');
      vi.advanceTimersByTime(2_000);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('is a no-op for unknown chatJid', () => {
      const onStopped = vi.fn();
      const manager = makeManager({ onStopped });
      manager.stopSession('tg:unknown');
      expect(onStopped).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getLatestPosition
  // -------------------------------------------------------------------------

  describe('getLatestPosition', () => {
    it('returns position for active session', () => {
      const manager = makeManager();
      manager.startSession('tg:1', 1, 35.6762, 139.6503, 600, 10.5, 90);
      const pos = manager.getLatestPosition('tg:1');
      expect(pos?.latestLat).toBe(35.6762);
      expect(pos?.latestLng).toBe(139.6503);
      expect(pos?.latestHorizontalAccuracy).toBe(10.5);
      expect(pos?.latestHeading).toBe(90);
      expect(pos?.logFilePath).toContain(LOG_DIR);
    });

    it('returns undefined for unknown chatJid', () => {
      const manager = makeManager();
      expect(manager.getLatestPosition('tg:unknown')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Log rotation
  // -------------------------------------------------------------------------

  describe('rotateLogs / appendLogEntry', () => {
    it('does NOT rotate when file size is below 1 MiB', () => {
      statSyncSpy.mockReturnValue({ size: 1024 * 1024 - 1 } as fs.Stats);
      const manager = makeManager();
      manager.startSession('tg:1', 1, 35, 139, 600);

      expect(renameSyncSpy).not.toHaveBeenCalled();
    });

    it('rotates when file size is exactly 1 MiB', () => {
      statSyncSpy.mockReturnValue({ size: 1024 * 1024 } as fs.Stats);
      const manager = makeManager();
      manager.startSession('tg:1', 1, 35, 139, 600);

      // Should rename .log → .log.1
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\.log$/),
        expect.stringMatching(/\.log\.1$/),
      );
    });

    it('deletes .log.5 and shifts backups during rotation', () => {
      statSyncSpy.mockReturnValue({ size: 1024 * 1024 } as fs.Stats);
      const manager = makeManager();
      manager.startSession('tg:1', 1, 35, 139, 600);

      // .log.5 should be unlinked
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\.log\.5$/),
      );
      // .log.4 → .log.5
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\.log\.4$/),
        expect.stringMatching(/\.log\.5$/),
      );
    });
  });

  // -------------------------------------------------------------------------
  // cleanupOldLogs
  // -------------------------------------------------------------------------

  describe('cleanupOldLogs', () => {
    it('deletes files older than 7 days', () => {
      const oldMtime = Date.now() - 8 * 24 * 60 * 60 * 1000;
      readdirSyncSpy.mockReturnValue([
        'old.log',
        'old.log.1',
      ] as unknown as fs.Dirent[]);
      statSyncSpy.mockReturnValue({ mtimeMs: oldMtime } as fs.Stats);

      const manager = makeManager();
      manager.cleanupOldLogs();

      expect(unlinkSyncSpy).toHaveBeenCalledTimes(2);
    });

    it('keeps files newer than 7 days', () => {
      const recentMtime = Date.now() - 1 * 24 * 60 * 60 * 1000;
      readdirSyncSpy.mockReturnValue(['recent.log'] as unknown as fs.Dirent[]);
      statSyncSpy.mockReturnValue({ mtimeMs: recentMtime } as fs.Stats);

      const manager = makeManager();
      manager.cleanupOldLogs();

      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('ignores non-log files', () => {
      readdirSyncSpy.mockReturnValue([
        'notes.txt',
        'data.json',
      ] as unknown as fs.Dirent[]);

      const manager = makeManager();
      manager.cleanupOldLogs();

      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('does not throw when log dir does not exist', () => {
      readdirSyncSpy.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const manager = makeManager();
      expect(() => manager.cleanupOldLogs()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // initialize
  // -------------------------------------------------------------------------

  describe('initialize', () => {
    it('creates log dir and runs initial cleanup', () => {
      readdirSyncSpy.mockReturnValue([]);
      const manager = makeManager();
      manager.initialize();

      expect(mkdirSyncSpy).toHaveBeenCalledWith(LOG_DIR, { recursive: true });
    });

    it('schedules hourly cleanup', () => {
      readdirSyncSpy.mockReturnValue([]);
      const oldMtime = Date.now() - 8 * 24 * 60 * 60 * 1000;

      const manager = makeManager();
      manager.initialize();

      // Simulate an old file appearing
      readdirSyncSpy.mockReturnValue(['stale.log'] as unknown as fs.Dirent[]);
      statSyncSpy.mockReturnValue({ mtimeMs: oldMtime } as fs.Stats);

      vi.advanceTimersByTime(60 * 60 * 1000 + 1); // 1 hour
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Timeout fires — session removed
  // -------------------------------------------------------------------------

  describe('timeout lifecycle', () => {
    it('removes session from map when timeout fires', () => {
      const manager = makeManager({ idleTimeoutMs: 1_000 });
      manager.startSession('tg:1', 1, 35, 139, 0x7fffffff);
      expect(manager.getLatestPosition('tg:1')).toBeDefined();

      vi.advanceTimersByTime(1_001);
      expect(manager.getLatestPosition('tg:1')).toBeUndefined();
    });

    it('calls onTimeout when timeout fires (non-recovery)', () => {
      const onTimeout = vi.fn();
      const manager = makeManager({ idleTimeoutMs: 1_000, onTimeout });
      manager.startSession('tg:1', 1, 35, 139, 0x7fffffff);

      vi.advanceTimersByTime(1_001);
      expect(onTimeout).toHaveBeenCalledWith('tg:1');
    });
  });
});

// ---------------------------------------------------------------------------
// Module-level accessor
// ---------------------------------------------------------------------------

describe('_setActiveLiveLocationManager / getActiveLiveLocationContext', () => {
  let statSyncSpy: Mock;
  let appendFileSyncSpy: Mock;
  let mkdirSyncSpy: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined) as Mock;
    appendFileSyncSpy = vi
      .spyOn(fs, 'appendFileSync')
      .mockReturnValue(undefined) as Mock;
    statSyncSpy = vi
      .spyOn(fs, 'statSync')
      .mockReturnValue({ size: 0 } as fs.Stats) as Mock;
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fs, 'renameSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _setActiveLiveLocationManager(null);
    void mkdirSyncSpy;
    void appendFileSyncSpy;
    void statSyncSpy;
  });

  it('returns empty string before manager is set', () => {
    expect(getActiveLiveLocationContext('tg:1')).toBe('');
  });

  it('returns prefix string when manager has active session', () => {
    const manager = makeManager();
    manager.startSession('tg:1', 1, 35.6762, 139.6503, 600);
    _setActiveLiveLocationManager(manager);

    const ctx = getActiveLiveLocationContext('tg:1');
    expect(ctx).toContain('[Live location sharing enabled]');
    expect(ctx).toContain('lat: 35.6762');
    expect(ctx).toContain('long: 139.6503');
    expect(ctx).toContain('tail');
    expect(ctx.endsWith('\n')).toBe(true);
  });

  it('returns empty string for unknown chatJid even when manager is set', () => {
    const manager = makeManager();
    _setActiveLiveLocationManager(manager);
    expect(getActiveLiveLocationContext('tg:unknown')).toBe('');
  });

  it('returns empty string after manager is set to null', () => {
    const manager = makeManager();
    manager.startSession('tg:1', 1, 35, 139, 600);
    _setActiveLiveLocationManager(manager);
    expect(getActiveLiveLocationContext('tg:1')).not.toBe('');

    _setActiveLiveLocationManager(null);
    expect(getActiveLiveLocationContext('tg:1')).toBe('');
  });
});
