import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Package root: where the agentlite package is installed (resolved from this module's location).
// Used as the default assets root for container/, groups/ templates, etc.
export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// Env config is NOT loaded at import time — SDK consumers call loadEnvConfig()
// explicitly (via CLI) so the library is side-effect-free when embedded.
let envConfig: Record<string, string> = {};

/** Load .env config values. Called by CLI before constructing AgentLite.
 *  SDK mode skips this — consumers set config explicitly. */
export function loadEnvConfig(): void {
  envConfig = readEnvFile(
    ['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'ONECLI_URL', 'TZ'],
  );
  // Re-derive values that depend on envConfig
  if (!_assistantNameOverridden) {
    ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
    TRIGGER_PATTERN = new RegExp(`^@${escapeRegex(ASSISTANT_NAME)}\\b`, 'i');
  }
  ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
  TIMEZONE = resolveConfigTimezone();
}

export let ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts.
// PROJECT_ROOT can be overridden via setProjectRoot() for SDK usage.
let PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

/** Get the current project root directory. */
export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

/** Override the project root directory (used by SDK's workdir option).
 *  Updates all derived paths via ESM live bindings. */
export function setProjectRoot(dir: string): void {
  PROJECT_ROOT = path.resolve(dir);
  STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
  GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
  DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
}

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export let STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export let GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export let DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Assets root: read-only package assets (container/, groups/ templates, OCI image).
// Defaults to PACKAGE_ROOT. Can be overridden for packaged apps (e.g., Electron).
let ASSETS_ROOT = PACKAGE_ROOT;

/** Get the current assets root directory. */
export function getAssetsRoot(): string {
  return ASSETS_ROOT;
}

/** Override the assets root directory.
 *  Updates BOX_ROOTFS_PATH (unless overridden by env var). */
export function setAssetsRoot(dir: string): void {
  ASSETS_ROOT = path.resolve(dir);
  if (!process.env.BOX_ROOTFS_PATH) {
    BOX_ROOTFS_PATH = path.join(ASSETS_ROOT, 'container', 'oci-image');
  }
}

export const BOX_IMAGE =
  process.env.BOX_IMAGE || 'ghcr.io/boxlite-ai/agentlite-agent:latest';
// Path to OCI layout directory exported by container/build.sh.
// When set, BoxLite uses this local rootfs instead of pulling from a registry.
export let BOX_ROOTFS_PATH = process.env.BOX_ROOTFS_PATH || path.join(
  ASSETS_ROOT,
  'container',
  'oci-image',
);
export const BOX_MEMORY_MIB = parseInt(
  process.env.BOX_MEMORY_MIB || '2048',
  10,
);
export const BOX_CPUS = parseInt(process.env.BOX_CPUS || '2', 10);
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export let ONECLI_URL =
  process.env.ONECLI_URL || 'http://localhost:10254';
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export let TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

let _assistantNameOverridden = false;

/** Override the assistant name (used by SDK). Updates TRIGGER_PATTERN too. */
export function setAssistantName(name: string): void {
  _assistantNameOverridden = true;
  ASSISTANT_NAME = name;
  TRIGGER_PATTERN = new RegExp(`^@${escapeRegex(name)}\\b`, 'i');
}

// Timezone for scheduled tasks, message formatting, etc.
// Resolved at import time from process.env and Intl (no .env needed).
// Re-derived when loadEnvConfig() is called (CLI adds .env TZ).
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export let TIMEZONE = resolveConfigTimezone();

// ─── CLI env → SDK options adapter ──────────────────────────────────

import type { AgentLiteOptions } from './config.js';

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  return isNaN(n) ? undefined : n;
}

/**
 * Build AgentLiteOptions from .env + process.env.
 * Called by CLI to convert env config into typed options.
 * Must be called after loadEnvConfig().
 */
export function buildOptionsFromEnv(): AgentLiteOptions {
  return {
    name: process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || undefined,
    timezone: process.env.TZ || envConfig.TZ || undefined,
    onecliUrl: process.env.ONECLI_URL || envConfig.ONECLI_URL || undefined,
    container: {
      image: process.env.BOX_IMAGE || undefined,
      rootfsPath: process.env.BOX_ROOTFS_PATH || undefined,
      memoryMib: parseOptionalInt(process.env.BOX_MEMORY_MIB),
      cpus: parseOptionalInt(process.env.BOX_CPUS),
      timeout: parseOptionalInt(process.env.CONTAINER_TIMEOUT),
      maxOutputSize: parseOptionalInt(process.env.CONTAINER_MAX_OUTPUT_SIZE),
      maxConcurrent: parseOptionalInt(process.env.MAX_CONCURRENT_CONTAINERS),
      idleTimeout: parseOptionalInt(process.env.IDLE_TIMEOUT),
    },
  };
}
