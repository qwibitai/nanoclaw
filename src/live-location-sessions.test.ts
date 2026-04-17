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

describe('LiveLocationManager — log file path naming', () => {
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

describe('LiveLocationManager — timeout calculation', () => {
  it('uses min(livePeriod*1000, idleTimeoutMs) for normal live_period', () => {
    const onTimeout = vi.fn();
    const manager = makeManager({ idleTimeoutMs: 300_000, onTimeout });
    manager.startSession('tg:1', 1, 35, 139, 60);
    vi.advanceTimersByTime(60_001);
    expect(onTimeout).toHaveBeenCalledWith('tg:1');
  });

  it('caps at idleTimeoutMs when livePeriod*1000 exceeds it', () => {
    const onTimeout = vi.fn();
    const manager = makeManager({ idleTimeoutMs: 5_000, onTimeout });
    manager.startSession('tg:1', 1, 35, 139, 86400);
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

describe('LiveLocationManager — startSession', () => {
  it('creates dir, writes JSONL entry, returns log path', () => {
    const manager = makeManager();
    const logPath = manager.startSession('tg:100', 1, 35.6762, 139.6503, 600);

    expect(fsSpies.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(LOG_DIR),
      { recursive: true },
    );
    expect(fsSpies.appendFileSync).toHaveBeenCalledOnce();
    const written = fsSpies.appendFileSync.mock.calls[0][1] as string;
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
    const written = fsSpies.appendFileSync.mock.calls[0][1] as string;
    const entry = JSON.parse(written.trim());
    expect(entry.horizontal_accuracy).toBe(10.5);
    expect(entry.heading).toBe(180);
  });

  it('cancels previous session timer when starting a new session for same chat', () => {
    const onTimeout = vi.fn();
    const manager = makeManager({ idleTimeoutMs: 5_000, onTimeout });
    manager.startSession('tg:1', 1, 35, 139, 60);
    manager.startSession('tg:1', 2, 36, 140, 60);
    vi.advanceTimersByTime(61_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('LiveLocationManager — updateSession / updated', () => {
  it('appends log entry and returns updated', () => {
    const manager = makeManager();
    manager.startSession('tg:1', 1, 35, 139, 600);
    fsSpies.appendFileSync.mockClear();

    const result = manager.updateSession('tg:1', 1, 36, 140);
    expect(result).toBe('updated');
    expect(fsSpies.appendFileSync).toHaveBeenCalledOnce();
  });

  it('resets idle timeout on update', () => {
    const onTimeout = vi.fn();
    const manager = makeManager({ idleTimeoutMs: 5_000, onTimeout });
    manager.startSession('tg:1', 1, 35, 139, 0x7fffffff);

    vi.advanceTimersByTime(4_000);
    manager.updateSession('tg:1', 1, 36, 140);

    vi.advanceTimersByTime(4_000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_100);
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

describe('LiveLocationManager — updateSession / stopped', () => {
  it('returns stopped and still appends final entry', () => {
    const manager = makeManager();
    manager.startSession('tg:1', 1, 35, 139, 600);
    fsSpies.appendFileSync.mockClear();

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
    expect(fsSpies.appendFileSync).toHaveBeenCalledOnce();
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

describe('LiveLocationManager — updateSession / recovery-created', () => {
  it('creates recovery session when log file exists but no active session', () => {
    fsSpies.existsSync.mockReturnValue(true);
    const manager = makeManager();

    const result = manager.updateSession('tg:1', 5, 35, 139);
    expect(result).toBe('recovery-created');
    expect(fsSpies.appendFileSync).toHaveBeenCalledOnce();
    expect(manager.getLatestPosition('tg:1')).toBeDefined();
  });

  it('does NOT fire onTimeout when recovery session times out', () => {
    fsSpies.existsSync.mockReturnValue(true);
    const onTimeout = vi.fn();
    const manager = makeManager({ idleTimeoutMs: 1_000, onTimeout });
    manager.updateSession('tg:1', 5, 35, 139);

    vi.advanceTimersByTime(1_100);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('silently ignores update when no session and no log file', () => {
    fsSpies.existsSync.mockReturnValue(false);
    const manager = makeManager();

    const result = manager.updateSession('tg:2', 99, 35, 139);
    expect(result).toBe('updated');
    expect(fsSpies.appendFileSync).not.toHaveBeenCalled();
  });
});

describe('LiveLocationManager — stopSession', () => {
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

describe('LiveLocationManager — getLatestPosition', () => {
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

describe('LiveLocationManager — timeout lifecycle', () => {
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

// Silence TS unused-var warning for the default no-op spy (fs is used
// indirectly via the manager's internal calls).
void fs;
