// Bot configuration — dynamic registry backed by the telemetry service API.

import { BotRegistry } from './registry-client.js';

export interface BotConfig {
  name: string;
  sshTarget: string; // e.g. "ubuntu@100.88.246.12" or "rog"
  container: string;
  configPaths: string[];
  githubIssuesRepo: string; // "owner/repo" — where the bot opens/tracks issues
  githubSourceRepo: string; // "owner/repo" — deployment code & config
  localProjectDir: string; // Mac directory with CLAUDE.md, guidelines, memory
  framework: string;
  notes: string[];
  telemetryBotId: string; // UUID used by the UTI telemetry service
}

// ── Registry-backed config ──────────────────────────────────────

const REGISTRY_URL = process.env.REGISTRY_URL || 'http://100.99.148.99:3100';
const CACHE_PATH =
  process.env.REGISTRY_CACHE_PATH || `${process.env.HOME}/nanoclaw/data/bot-configs.json`;

let registry: BotRegistry | null = null;
let registryReady = false;

/** Get or create the singleton registry instance. */
export function getRegistry(): BotRegistry {
  if (!registry) {
    registry = new BotRegistry(REGISTRY_URL, CACHE_PATH);
  }
  return registry;
}

/** Initialize registry (call once at startup). Non-blocking if already init'd. */
export async function initRegistry(): Promise<void> {
  if (registryReady) return;
  const reg = getRegistry();
  await reg.init();
  reg.startPolling();
  registryReady = true;
}

/** Refresh configs from registry. Returns diff summary. */
export async function refreshConfigs() {
  const reg = getRegistry();
  return reg.refresh();
}

// ── Public API (synchronous — used by all tools) ────────────────

export function getBotConfig(bot: string): BotConfig {
  const reg = getRegistry();
  return reg.getBot(bot);
}

/** @internal Seed registry with test data. Only for use in tests. */
export function _seedRegistryForTesting(bots: Record<string, BotConfig>): void {
  const reg = getRegistry();
  // Use the internal setBots method on the registry
  (reg as unknown as { bots: Record<string, BotConfig> }).bots = bots;
}

export const SSH_CONNECT_TIMEOUT = 10;
export const SSH_COMMAND_TIMEOUT = 30;
export const MAX_LOG_LINES = 500;
export const MAX_SEARCH_DEPTH = 5000;
export const MAX_FILE_SIZE = 50 * 1024; // 50KB for reads
export const MAX_EDIT_FILE_SIZE = 100 * 1024; // 100KB for edits

export const ALLOWED_DOCKER_ACTIONS = ['restart', 'stop', 'start', 'exec'] as const;
export type DockerAction = (typeof ALLOWED_DOCKER_ACTIONS)[number];

export const BLOCKED_DOCKER_PATTERNS = [
  'down',
  'rm',
  'prune',
  'volume rm',
  'volume remove',
  'compose down',
] as const;
