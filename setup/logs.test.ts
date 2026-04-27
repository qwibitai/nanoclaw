import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lastStepFields, progressLogPath } from './logs.js';

/**
 * lastStepFields tails the structured progression log written by step() and
 * returns the most recent block matching a given step name. Used by the
 * failure-hint renderer and the centralised restart helper to find out
 * which service mode this install actually ended up with.
 *
 * Tests run in a temp cwd because logs.ts pins the log path to a relative
 * `logs/setup.log` (see PROGRESS_LOG in logs.ts).
 */
describe('lastStepFields', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncw-last-step-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the log does not exist', () => {
    expect(lastStepFields('service')).toBeNull();
  });

  it('returns null when the log exists but no matching step', () => {
    fs.mkdirSync(path.dirname(progressLogPath), { recursive: true });
    fs.writeFileSync(
      progressLogPath,
      '## 2026-04-26T23:00:00Z · setup:auto started\n\n=== [2026-04-26T23:00:01Z] bootstrap [1s] → success ===\n  platform: linux\n\n',
    );
    expect(lastStepFields('service')).toBeNull();
  });

  it('parses fields from a single matching block', () => {
    fs.mkdirSync(path.dirname(progressLogPath), { recursive: true });
    fs.writeFileSync(
      progressLogPath,
      [
        '## 2026-04-26T23:00:00Z · setup:auto started',
        '',
        '=== [2026-04-26T23:00:05Z] service [5.0s] → success ===',
        '  service_type: nohup',
        '  service_loaded: true',
        '  fallback: wsl_no_systemd',
        '  raw: logs/setup-steps/01-service.log',
        '',
      ].join('\n'),
    );
    const fields = lastStepFields('service');
    expect(fields).not.toBeNull();
    expect(fields?.service_type).toBe('nohup');
    expect(fields?.service_loaded).toBe('true');
    expect(fields?.fallback).toBe('wsl_no_systemd');
  });

  it('returns the most recent matching block when several exist', () => {
    fs.mkdirSync(path.dirname(progressLogPath), { recursive: true });
    fs.writeFileSync(
      progressLogPath,
      [
        '=== [2026-04-26T23:00:01Z] service [1s] → failed ===',
        '  service_type: nohup',
        '  status: failed',
        '',
        '=== [2026-04-26T23:00:10Z] service [2s] → success ===',
        '  service_type: systemd-user',
        '  service_loaded: true',
        '',
      ].join('\n'),
    );
    const fields = lastStepFields('service');
    expect(fields?.service_type).toBe('systemd-user');
    expect(fields?.service_loaded).toBe('true');
    expect(fields?.status).toBeUndefined();
  });

  it('does not match a step whose name contains the query as a substring', () => {
    fs.mkdirSync(path.dirname(progressLogPath), { recursive: true });
    fs.writeFileSync(
      progressLogPath,
      '=== [2026-04-26T23:00:01Z] cli-agent [1s] → success ===\n  agent_name: Terminal Agent\n\n',
    );
    expect(lastStepFields('agent')).toBeNull();
    expect(lastStepFields('cli-agent')?.agent_name).toBe('Terminal Agent');
  });
});
