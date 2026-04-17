import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _setActiveLiveLocationManager } from './live-location.js';
import {
  LOG_DIR,
  installLlFsSpies,
  makeManager,
  type LlFsSpies,
} from './live-location-test-harness.js';

let fsSpies: LlFsSpies;

beforeEach(() => {
  vi.useFakeTimers();
  fsSpies = installLlFsSpies();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  _setActiveLiveLocationManager(null);
});

describe('LiveLocationManager — log rotation', () => {
  it('does NOT rotate when file size is below 1 MiB', () => {
    fsSpies.statSync.mockReturnValue({ size: 1024 * 1024 - 1 } as fs.Stats);
    const manager = makeManager();
    manager.startSession('tg:1', 1, 35, 139, 600);

    expect(fsSpies.renameSync).not.toHaveBeenCalled();
  });

  it('rotates when file size is exactly 1 MiB', () => {
    fsSpies.statSync.mockReturnValue({ size: 1024 * 1024 } as fs.Stats);
    const manager = makeManager();
    manager.startSession('tg:1', 1, 35, 139, 600);

    expect(fsSpies.renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.log$/),
      expect.stringMatching(/\.log\.1$/),
    );
  });

  it('deletes .log.5 and shifts backups during rotation', () => {
    fsSpies.statSync.mockReturnValue({ size: 1024 * 1024 } as fs.Stats);
    const manager = makeManager();
    manager.startSession('tg:1', 1, 35, 139, 600);

    expect(fsSpies.unlinkSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.log\.5$/),
    );
    expect(fsSpies.renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.log\.4$/),
      expect.stringMatching(/\.log\.5$/),
    );
  });
});

describe('LiveLocationManager — cleanupOldLogs', () => {
  it('deletes files older than 7 days', () => {
    const oldMtime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fsSpies.readdirSync.mockReturnValue([
      'old.log',
      'old.log.1',
    ] as unknown as fs.Dirent[]);
    fsSpies.statSync.mockReturnValue({ mtimeMs: oldMtime } as fs.Stats);

    const manager = makeManager();
    manager.cleanupOldLogs();

    expect(fsSpies.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('keeps files newer than 7 days', () => {
    const recentMtime = Date.now() - 1 * 24 * 60 * 60 * 1000;
    fsSpies.readdirSync.mockReturnValue([
      'recent.log',
    ] as unknown as fs.Dirent[]);
    fsSpies.statSync.mockReturnValue({ mtimeMs: recentMtime } as fs.Stats);

    const manager = makeManager();
    manager.cleanupOldLogs();

    expect(fsSpies.unlinkSync).not.toHaveBeenCalled();
  });

  it('ignores non-log files', () => {
    fsSpies.readdirSync.mockReturnValue([
      'notes.txt',
      'data.json',
    ] as unknown as fs.Dirent[]);

    const manager = makeManager();
    manager.cleanupOldLogs();

    expect(fsSpies.unlinkSync).not.toHaveBeenCalled();
  });

  it('does not throw when log dir does not exist', () => {
    fsSpies.readdirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const manager = makeManager();
    expect(() => manager.cleanupOldLogs()).not.toThrow();
  });
});

describe('LiveLocationManager — initialize', () => {
  it('creates log dir and runs initial cleanup', () => {
    fsSpies.readdirSync.mockReturnValue([]);
    const manager = makeManager();
    manager.initialize();

    expect(fsSpies.mkdirSync).toHaveBeenCalledWith(LOG_DIR, {
      recursive: true,
    });
  });

  it('schedules hourly cleanup', () => {
    fsSpies.readdirSync.mockReturnValue([]);
    const oldMtime = Date.now() - 8 * 24 * 60 * 60 * 1000;

    const manager = makeManager();
    manager.initialize();

    fsSpies.readdirSync.mockReturnValue(['stale.log'] as unknown as fs.Dirent[]);
    fsSpies.statSync.mockReturnValue({ mtimeMs: oldMtime } as fs.Stats);

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(fsSpies.unlinkSync).toHaveBeenCalled();
  });
});
