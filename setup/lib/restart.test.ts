import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectInstalledServiceMode, restartService } from './restart.js';

/**
 * Tests for the centralised restart helper.
 *
 * `detectInstalledServiceMode` is pure log-reading, so we exercise it with
 * synthetic logs in a temp cwd. `restartService` is harder to test in
 * isolation because it shells out to launchctl/systemctl/bash — we only
 * assert the failure path that doesn't require real services (no wrapper
 * file, no service artifacts → returns ok=false reason=no_service_artifact).
 */
describe('detectInstalledServiceMode', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncw-detect-mode-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeServiceLog(serviceType: string): void {
    fs.mkdirSync('logs', { recursive: true });
    fs.writeFileSync(
      'logs/setup.log',
      [
        `=== [2026-04-26T23:00:01Z] service [1s] → success ===`,
        `  service_type: ${serviceType}`,
        `  service_loaded: true`,
        '',
      ].join('\n'),
    );
  }

  it('returns "unknown" when the log is missing', () => {
    expect(detectInstalledServiceMode(tmpDir)).toBe('unknown');
  });

  it('returns "unknown" when the service step has not run yet', () => {
    fs.mkdirSync('logs', { recursive: true });
    fs.writeFileSync(
      'logs/setup.log',
      '=== [2026-04-26T23:00:01Z] bootstrap [1s] → success ===\n  platform: linux\n\n',
    );
    expect(detectInstalledServiceMode(tmpDir)).toBe('unknown');
  });

  it('reads each known mode from the log', () => {
    for (const mode of ['launchd', 'systemd-user', 'systemd-system', 'nohup']) {
      writeServiceLog(mode);
      expect(detectInstalledServiceMode(tmpDir)).toBe(mode);
    }
  });

  it('coerces unrecognised modes to "unknown"', () => {
    writeServiceLog('upstart-from-2009');
    expect(detectInstalledServiceMode(tmpDir)).toBe('unknown');
  });
});

describe('restartService', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncw-restart-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports no_service_artifact when nohup mode is requested but the wrapper does not exist', async () => {
    const result = await restartService(tmpDir, 'nohup');
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('nohup');
    expect(result.reason).toBe('no_service_artifact');
  });

  it('reports no_service_artifact when no mode is recorded and no wrapper exists', async () => {
    const result = await restartService(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('unknown');
    expect(result.reason).toBe('no_service_artifact');
  });
});
