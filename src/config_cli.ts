/**
 * CLI config adapter — reads .env + process.env and builds SDK options.
 * Only imported by cli.ts. SDK consumers never touch this file.
 */

import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { resolveMountAllowlist } from './mount-security.js';
import { isValidTimezone } from './timezone.js';
import type { AgentLiteOptions, AgentOptions } from './api/options.js';

let envConfig: Record<string, string> = {};

/** Load .env config values. Called by CLI before constructing AgentLite. */
export function loadEnvConfig(): void {
  envConfig = readEnvFile([
    'ASSISTANT_NAME',
    'ASSISTANT_HAS_OWN_NUMBER',
    'ONECLI_URL',
    'TZ',
  ]);
}

function resolveTimezone(): string | undefined {
  const candidates = [process.env.TZ, envConfig.TZ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return undefined;
}

/** Build AgentLiteOptions (platform-level) from env. */
export function buildOptionsFromEnv(): AgentLiteOptions {
  return {
    workdir: process.env.AGENTLITE_WORKDIR || undefined,
    boxImage: process.env.BOX_IMAGE || undefined,
    onecliUrl: process.env.ONECLI_URL || envConfig.ONECLI_URL || undefined,
    timezone: resolveTimezone(),
  };
}

/** Build AgentOptions (per-agent) from env. */
export function buildAgentOptionsFromEnv(): AgentOptions {
  const allowlistPath = path.join(
    os.homedir(),
    '.config',
    'agentlite',
    'mount-allowlist.json',
  );
  return {
    name: process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || undefined,
    mountAllowlist: resolveMountAllowlist(null, allowlistPath) ?? undefined,
  };
}
