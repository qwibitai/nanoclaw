/**
 * AgentLite SDK configuration facade.
 *
 * All config vars are `export let` with pure defaults (no process.env reads).
 * SDK consumers call applyConfig() once during start() to set everything.
 * Other modules import from here — ESM live bindings ensure they see updates.
 *
 * CLI mode uses config_cli.ts (the original config file) to read .env and
 * process.env, then converts them into AgentLiteOptions passed to applyConfig().
 * In SDK mode, config_cli.ts is never imported — zero side effects.
 */
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { isValidTimezone } from './timezone.js';

import type { AgentLiteOptions } from './options.js';

/** Internal config overrides (not part of public SDK API). Used by CLI. */
export interface InternalConfigOverrides {
  timezone?: string;
  boxImage?: string;
  boxRootfsPath?: string;
  boxMemoryMib?: number;
  boxCpus?: number;
  containerTimeout?: number;
  containerMaxOutputSize?: number;
  maxConcurrentContainers?: number;
  idleTimeout?: number;
  onecliUrl?: string;
  mountAllowlistPath?: string;
  senderAllowlistPath?: string;
}

// ─── Package root (immutable) ───────────────────────────────────────

// Package root: where the agentlite package is installed (resolved from this module's location).
// Used as the default assets root for container/, groups/ templates, etc.
export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// ─── Mutable config vars (ESM live bindings) ────────────────────────
// All `export let` — consumers see updated values after applyConfig().
// Defaults are pure (no process.env reads at import time) so the SDK
// is side-effect-free when embedded.

export let ASSISTANT_NAME = 'Andy';
export let ASSISTANT_HAS_OWN_NUMBER = false;
export let POLL_INTERVAL = 2000;
export let SCHEDULER_POLL_INTERVAL = 60000;
export let IPC_POLL_INTERVAL = 1000;

// Absolute paths — set by applyConfig({ workdir }) before any access.
// No process.cwd() default: Electron embeds can't rely on cwd at import time.
let PROJECT_ROOT = '';
const HOME_DIR = process.env.HOME || os.homedir();

/** Get the current project root directory. */
export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export let MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'agentlite',
  'mount-allowlist.json',
);
export let SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'agentlite',
  'sender-allowlist.json',
);
export let STORE_DIR = '';
export let GROUPS_DIR = '';
export let DATA_DIR = '';

export let BOX_IMAGE = 'ghcr.io/boxlite-ai/agentlite-agent:latest';
// Optional path to a local OCI layout directory. When set, BoxLite uses this
// rootfs instead of pulling BOX_IMAGE from a registry. Only set via
// applyInternalConfig({ boxRootfsPath }) — no default, since the OCI image
// is a build artifact that may not exist.
export let BOX_ROOTFS_PATH = '';
export let BOX_MEMORY_MIB = 2048;
export let BOX_CPUS = 2;
export let CONTAINER_TIMEOUT = 1_800_000;
export let CONTAINER_MAX_OUTPUT_SIZE = 10_485_760; // 10MB default
export let ONECLI_URL = 'http://localhost:10254';
export let IDLE_TIMEOUT = 1_800_000; // 30min default — how long to keep container alive after last result
export let MAX_CONCURRENT_CONTAINERS = 5;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export let TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

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

export let TIMEZONE = resolveTimezone();

// ─── applyConfig — the single entry point for SDK ───────────────────

/**
 * Apply resolved options to all config vars.
 * Called once by AgentLite.start() — every module that imports from
 * config.ts sees the updated values via ESM live bindings.
 * No other module needs to change.
 */
export function applyConfig(opts: AgentLiteOptions): void {
  // Identity
  if (opts.name) {
    ASSISTANT_NAME = opts.name;
    TRIGGER_PATTERN = new RegExp(`^@${escapeRegex(opts.name)}\\b`, 'i');
  }

  // Paths — workdir is resolved at call time (not import time) so Electron
  // embeds get a real filesystem path instead of an ASAR-relative cwd.
  PROJECT_ROOT = path.resolve(opts.workdir ?? process.cwd());
  STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
  GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
  DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
}

/**
 * Apply internal config overrides (not part of public SDK API).
 * Used by CLI to forward env-based values to config vars.
 */
export function applyInternalConfig(o: InternalConfigOverrides): void {
  if (o.timezone) TIMEZONE = resolveTimezone(o.timezone);
  if (o.boxImage !== undefined) BOX_IMAGE = o.boxImage;
  if (o.boxRootfsPath !== undefined) BOX_ROOTFS_PATH = o.boxRootfsPath;
  if (o.boxMemoryMib !== undefined) BOX_MEMORY_MIB = o.boxMemoryMib;
  if (o.boxCpus !== undefined) BOX_CPUS = o.boxCpus;
  if (o.containerTimeout !== undefined) CONTAINER_TIMEOUT = o.containerTimeout;
  if (o.containerMaxOutputSize !== undefined)
    CONTAINER_MAX_OUTPUT_SIZE = o.containerMaxOutputSize;
  if (o.maxConcurrentContainers !== undefined)
    MAX_CONCURRENT_CONTAINERS = Math.max(1, o.maxConcurrentContainers);
  if (o.idleTimeout !== undefined) IDLE_TIMEOUT = o.idleTimeout;
  if (o.onecliUrl !== undefined) ONECLI_URL = o.onecliUrl;
  if (o.mountAllowlistPath !== undefined)
    MOUNT_ALLOWLIST_PATH = o.mountAllowlistPath;
  if (o.senderAllowlistPath !== undefined)
    SENDER_ALLOWLIST_PATH = o.senderAllowlistPath;
}

// ─── Deprecated setters (kept for backward compat) ──────────────────

/** @deprecated Use applyConfig({ workdir }) instead. */
export function setProjectRoot(dir: string): void {
  applyConfig({ workdir: dir });
}

/** @deprecated Use applyConfig({ name }) instead. */
export function setAssistantName(name: string): void {
  applyConfig({ name });
}
