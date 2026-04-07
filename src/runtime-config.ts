/**
 * RuntimeConfig — immutable configuration for the shared BoxLite runtime.
 * Created once by AgentLite constructor. Replaces mutable `export let` globals from config.ts.
 */

import path from 'path';

import { isValidTimezone } from './timezone.js';
import type { AgentLiteOptions } from './api/options.js';

/** Immutable runtime config — shared across all agents in one AgentLite process. */
export interface RuntimeConfig {
  readonly packageRoot: string;
  readonly workdir: string;
  readonly boxImage: string;
  readonly boxRootfsPath: string;
  readonly boxMemoryMib: number;
  readonly boxCpus: number;
  readonly maxConcurrentContainers: number;
  readonly containerTimeout: number;
  readonly containerMaxOutputSize: number;
  readonly idleTimeout: number;
  readonly onecliUrl: string;
  readonly timezone: string;
  readonly pollInterval: number;
  readonly schedulerPollInterval: number;
  readonly ipcPollInterval: number;
}

function resolveTimezone(tz?: string): string {
  if (tz && isValidTimezone(tz)) return tz;
  try {
    const sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (sys && isValidTimezone(sys)) return sys;
  } catch {
    /* ignore */
  }
  return 'UTC';
}

/** Build an immutable RuntimeConfig from AgentLiteOptions. */
export function buildRuntimeConfig(
  opts: AgentLiteOptions,
  packageRoot: string,
): RuntimeConfig {
  return {
    packageRoot,
    workdir: path.resolve(opts.workdir ?? process.cwd()),
    boxImage: opts.boxImage ?? 'ghcr.io/boxlite-ai/agentlite-agent:latest',
    boxRootfsPath: '',
    boxMemoryMib: 2048,
    boxCpus: 2,
    maxConcurrentContainers: 5,
    containerTimeout: 1_800_000,
    containerMaxOutputSize: 10_485_760,
    idleTimeout: 1_800_000,
    onecliUrl: opts.onecliUrl ?? 'http://localhost:10254',
    timezone: resolveTimezone(opts.timezone),
    pollInterval: 2000,
    schedulerPollInterval: 60000,
    ipcPollInterval: 1000,
  };
}
