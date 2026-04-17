import fs from 'fs';

import { type Mock, vi } from 'vitest';

import {
  LiveLocationManager,
  LiveLocationManagerOpts,
} from './live-location.js';

export const LOG_DIR = '/tmp/test-location-logs';

export function makeOpts(
  overrides?: Partial<LiveLocationManagerOpts>,
): LiveLocationManagerOpts {
  return {
    logDir: LOG_DIR,
    idleTimeoutMs: 300_000,
    onTimeout: vi.fn(),
    onStopped: vi.fn(),
    ...overrides,
  };
}

export function makeManager(
  opts?: Partial<LiveLocationManagerOpts>,
): LiveLocationManager {
  return new LiveLocationManager(makeOpts(opts));
}

export interface LlFsSpies {
  mkdirSync: Mock;
  appendFileSync: Mock;
  statSync: Mock;
  existsSync: Mock;
  readdirSync: Mock;
  renameSync: Mock;
  unlinkSync: Mock;
}

/**
 * Install the fs-sync mock set every live-location test relies on.
 * Defaults: file does not exist, empty dir, file size 0 — individual
 * tests override `existsSync`/`statSync`/`readdirSync` as needed.
 */
export function installLlFsSpies(): LlFsSpies {
  return {
    mkdirSync: vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined) as Mock,
    appendFileSync: vi
      .spyOn(fs, 'appendFileSync')
      .mockReturnValue(undefined) as Mock,
    statSync: vi
      .spyOn(fs, 'statSync')
      .mockReturnValue({ size: 0 } as fs.Stats) as Mock,
    existsSync: vi.spyOn(fs, 'existsSync').mockReturnValue(false) as Mock,
    readdirSync: vi.spyOn(fs, 'readdirSync').mockReturnValue([]) as Mock,
    renameSync: vi.spyOn(fs, 'renameSync').mockReturnValue(undefined) as Mock,
    unlinkSync: vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined) as Mock,
  };
}
