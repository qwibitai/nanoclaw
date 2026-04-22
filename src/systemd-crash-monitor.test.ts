import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkServiceStatus,
  emitCrashEvent,
  loadCrashMonitorConfig,
  startCrashMonitor,
  stopCrashMonitor,
  _resetKnownFailures,
  _getKnownFailures,
  type CrashMonitorConfig,
  type CrashMonitorDeps,
} from './systemd-crash-monitor.js';

// Mock child_process.spawn
vi.mock('child_process', () => {
  const EventEmitter = require('events');
  const { Readable } = require('stream');

  return {
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      // Default: push empty and close with code 1 (not failed)
      setTimeout(() => {
        child.stdout.push(null);
        child.emit('close', 1);
      }, 0);
      return child;
    }),
  };
});

function makeMockDeps(overrides?: Partial<CrashMonitorDeps>): CrashMonitorDeps {
  return {
    registeredGroups: () => ({
      'main@g.us': {
        name: 'Main',
        folder: 'main',
        trigger: '',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      },
    }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<CrashMonitorConfig>,
): CrashMonitorConfig {
  return {
    services: ['nanoclaw', 'agency-hq'],
    intervalMs: 30000,
    opsFolder: 'ops',
    userMode: true,
    ...overrides,
  };
}

describe('systemd-crash-monitor', () => {
  beforeEach(() => {
    _resetKnownFailures();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopCrashMonitor();
    vi.restoreAllMocks();
  });

  describe('loadCrashMonitorConfig', () => {
    it('returns null when config file does not exist', () => {
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      const config = loadCrashMonitorConfig();
      expect(config).toBeNull();
    });

    it('returns null when services array is empty', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({ services: [] }),
      );

      const config = loadCrashMonitorConfig();
      expect(config).toBeNull();
    });

    it('filters invalid service names', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({ services: ['valid-name', '../etc/passwd', 'ok_one'] }),
      );

      const config = loadCrashMonitorConfig();
      expect(config).not.toBeNull();
      expect(config!.services).toEqual(['valid-name', 'ok_one']);
    });

    it('returns null when all service names are invalid', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({ services: ['../evil', '/bad/path'] }),
      );

      const config = loadCrashMonitorConfig();
      expect(config).toBeNull();
    });

    it('parses valid config with defaults', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({ services: ['nanoclaw'] }),
      );

      const config = loadCrashMonitorConfig();
      expect(config).toEqual({
        services: ['nanoclaw'],
        intervalMs: 30000,
        opsFolder: 'ops',
        userMode: true,
      });
    });

    it('respects custom config values', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          services: ['foo', 'bar'],
          intervalMs: 60000,
          opsFolder: 'devops',
          userMode: false,
        }),
      );

      const config = loadCrashMonitorConfig();
      expect(config).toEqual({
        services: ['foo', 'bar'],
        intervalMs: 60000,
        opsFolder: 'devops',
        userMode: false,
      });
    });

    it('accepts service names with @ and dots (template instances)', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          services: ['myapp@1.service', 'org.freedesktop.timesync1'],
        }),
      );

      const config = loadCrashMonitorConfig();
      expect(config!.services).toEqual([
        'myapp@1.service',
        'org.freedesktop.timesync1',
      ]);
    });
  });

  describe('emitCrashEvent', () => {
    it('writes an IPC task file to the correct directory', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

      emitCrashEvent(
        'nanoclaw',
        '2026-04-22T10:00:00Z',
        'some journal output',
        'ops',
      );

      expect(mkdirSpy).toHaveBeenCalledWith(
        expect.stringContaining(path.join('ipc', 'ops', 'tasks')),
        { recursive: true },
      );

      expect(writeSpy).toHaveBeenCalledTimes(1);
      const [filePath, content] = writeSpy.mock.calls[0] as [string, string];
      expect(filePath).toMatch(/crash-nanoclaw-\d+\.json$/);

      const payload = JSON.parse(content);
      expect(payload.type).toBe('schedule_task');
      expect(payload.prompt).toContain('nanoclaw');
      expect(payload.prompt).toContain('SYSTEMD CRASH');
      expect(payload.prompt).toContain('some journal output');
      expect(payload.schedule_type).toBe('once');
      expect(payload.targetJid).toBe('__ops__');
    });
  });

  describe('checkServiceStatus', () => {
    it('does nothing when no services are failed', async () => {
      // Default mock: spawn returns exitCode 1 (not failed)
      const deps = makeMockDeps();
      const config = makeConfig();

      await checkServiceStatus(config, deps);

      expect(deps.sendMessage).not.toHaveBeenCalled();
      expect(_getKnownFailures().size).toBe(0);
    });

    it('detects a failed service and emits IPC + notification', async () => {
      const { spawn } = await import('child_process');
      const EventEmitter = require('events');
      const { Readable } = require('stream');

      let callCount = 0;
      (spawn as ReturnType<typeof vi.fn>).mockImplementation(
        (cmd: string, args: string[]) => {
          const child = new EventEmitter();
          child.stdout = new Readable({ read() {} });
          child.stderr = new Readable({ read() {} });

          setTimeout(() => {
            if (cmd === 'systemctl' && args.includes('is-failed')) {
              callCount++;
              // First service (nanoclaw) is failed, second (agency-hq) is not
              if (args.includes('nanoclaw.service')) {
                child.stdout.push(null);
                child.emit('close', 0); // 0 = is-failed (yes, it's failed)
              } else {
                child.stdout.push(null);
                child.emit('close', 1); // 1 = not failed
              }
            } else if (cmd === 'journalctl') {
              child.stdout.push(Buffer.from('Apr 22 10:00:00 systemd: Failed'));
              child.stdout.push(null);
              child.emit('close', 0);
            } else {
              child.stdout.push(null);
              child.emit('close', 1);
            }
          }, 0);

          return child;
        },
      );

      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

      const deps = makeMockDeps();
      const config = makeConfig();

      await checkServiceStatus(config, deps);

      // Should have detected nanoclaw failure
      expect(_getKnownFailures().has('nanoclaw')).toBe(true);
      expect(_getKnownFailures().has('agency-hq')).toBe(false);

      // IPC file should have been written
      expect(writeSpy).toHaveBeenCalled();
      const [filePath] = writeSpy.mock.calls[0] as [string, string];
      expect(filePath).toMatch(/crash-nanoclaw/);

      // Notification sent to main group
      expect(deps.sendMessage).toHaveBeenCalledWith(
        'main@g.us',
        expect.stringContaining('[CRASH] Service failed: nanoclaw'),
      );
    });

    it('does not re-alert for already known failures', async () => {
      const { spawn } = await import('child_process');
      const EventEmitter = require('events');
      const { Readable } = require('stream');

      (spawn as ReturnType<typeof vi.fn>).mockImplementation(
        (cmd: string, args: string[]) => {
          const child = new EventEmitter();
          child.stdout = new Readable({ read() {} });
          child.stderr = new Readable({ read() {} });
          setTimeout(() => {
            if (cmd === 'systemctl' && args.includes('nanoclaw.service')) {
              child.stdout.push(null);
              child.emit('close', 0); // failed
            } else if (cmd === 'journalctl') {
              child.stdout.push(Buffer.from('log output'));
              child.stdout.push(null);
              child.emit('close', 0);
            } else {
              child.stdout.push(null);
              child.emit('close', 1);
            }
          }, 0);
          return child;
        },
      );

      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

      const deps = makeMockDeps();
      const config = makeConfig({ services: ['nanoclaw'] });

      // First check — should alert
      await checkServiceStatus(config, deps);
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);

      // Second check — same failure, should NOT re-alert
      (deps.sendMessage as ReturnType<typeof vi.fn>).mockClear();
      await checkServiceStatus(config, deps);
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('sends recovery notification when service comes back', async () => {
      const { spawn } = await import('child_process');
      const EventEmitter = require('events');
      const { Readable } = require('stream');

      let isServiceFailed = true;

      (spawn as ReturnType<typeof vi.fn>).mockImplementation(
        (cmd: string, args: string[]) => {
          const child = new EventEmitter();
          child.stdout = new Readable({ read() {} });
          child.stderr = new Readable({ read() {} });
          setTimeout(() => {
            if (cmd === 'systemctl' && args.includes('is-failed')) {
              child.stdout.push(null);
              child.emit('close', isServiceFailed ? 0 : 1);
            } else if (cmd === 'journalctl') {
              child.stdout.push(Buffer.from('journal'));
              child.stdout.push(null);
              child.emit('close', 0);
            } else {
              child.stdout.push(null);
              child.emit('close', 1);
            }
          }, 0);
          return child;
        },
      );

      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

      const deps = makeMockDeps();
      const config = makeConfig({ services: ['nanoclaw'] });

      // First: service fails
      await checkServiceStatus(config, deps);
      expect(_getKnownFailures().has('nanoclaw')).toBe(true);

      // Second: service recovers
      isServiceFailed = false;
      (deps.sendMessage as ReturnType<typeof vi.fn>).mockClear();
      await checkServiceStatus(config, deps);

      expect(_getKnownFailures().has('nanoclaw')).toBe(false);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        'main@g.us',
        expect.stringContaining('[RESOLVED] Service recovered: nanoclaw'),
      );
    });

    it('skips notification when no main group is registered', async () => {
      const { spawn } = await import('child_process');
      const EventEmitter = require('events');
      const { Readable } = require('stream');

      (spawn as ReturnType<typeof vi.fn>).mockImplementation(
        (cmd: string, args: string[]) => {
          const child = new EventEmitter();
          child.stdout = new Readable({ read() {} });
          child.stderr = new Readable({ read() {} });
          setTimeout(() => {
            if (cmd === 'systemctl') {
              child.stdout.push(null);
              child.emit('close', 0); // failed
            } else if (cmd === 'journalctl') {
              child.stdout.push(Buffer.from('log'));
              child.stdout.push(null);
              child.emit('close', 0);
            } else {
              child.stdout.push(null);
              child.emit('close', 1);
            }
          }, 0);
          return child;
        },
      );

      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

      const deps = makeMockDeps({
        registeredGroups: () => ({}), // no main group
      });
      const config = makeConfig({ services: ['nanoclaw'] });

      await checkServiceStatus(config, deps);

      // IPC file should still be written
      expect(fs.writeFileSync).toHaveBeenCalled();
      // But no notification sent
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('startCrashMonitor / stopCrashMonitor', () => {
    it('starts and stops without errors', () => {
      vi.useFakeTimers();

      const deps = makeMockDeps();
      const config = makeConfig();

      startCrashMonitor(config, deps);
      stopCrashMonitor();

      vi.useRealTimers();
    });

    it('polls on the configured interval', () => {
      vi.useFakeTimers();

      const deps = makeMockDeps();
      const config = makeConfig({ intervalMs: 10000 });

      startCrashMonitor(config, deps);

      // Advance past the initial delay
      vi.advanceTimersByTime(10001);

      stopCrashMonitor();
      vi.useRealTimers();
    });
  });
});
