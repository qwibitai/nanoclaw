/**
 * Central runtime constants and path/security defaults.
 * Docs map:
 * - docs/SPEC.md#configuration
 * - docs/SECURITY.md#2-mount-security
 * - docs/FORK_OVERVIEW.md
 */
import os from "os";
import path from "path";

import { readEnvFile } from "./env.js";
import { CONFIG_ROOT, PROJECT_ROOT } from "./runtime-paths.js";

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  "ASSISTANT_NAME",
  "CHANNEL_CONNECT_TIMEOUT",
  "CONTAINER_TIMEOUT",
  "CONTAINER_MAX_OUTPUT_SIZE",
  "CREDENTIAL_PROXY_PORT",
  "IDLE_TIMEOUT",
  "MAX_CONCURRENT_CONTAINERS",
]);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || "Andy";
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts.
// GROUPS_DIR can be relocated via NANOCLAW_CONFIG_ROOT.
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  ".config",
  "nanoclaw",
  "mount-allowlist.json",
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  ".config",
  "nanoclaw",
  "sender-allowlist.json",
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, "store");
export const GROUPS_DIR = path.resolve(CONFIG_ROOT, "groups");
export const DATA_DIR = path.resolve(PROJECT_ROOT, "data");

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name] || envConfig[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid integer for ${name}: "${raw}"`);
  }
  return parsed;
}

export const CHANNEL_CONNECT_TIMEOUT = parseIntEnv("CHANNEL_CONNECT_TIMEOUT", 30000);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || "nanoclaw-agent:latest";
export const CONTAINER_TIMEOUT = parseIntEnv("CONTAINER_TIMEOUT", 1800000);
export const CONTAINER_MAX_OUTPUT_SIZE = parseIntEnv("CONTAINER_MAX_OUTPUT_SIZE", 10485760); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseIntEnv("CREDENTIAL_PROXY_PORT", 3001);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseIntEnv("IDLE_TIMEOUT", 1800000); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseIntEnv("MAX_CONCURRENT_CONTAINERS", 5));
export const MAX_PROMPT_MESSAGES = 200;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const TRIGGER_PATTERN = new RegExp(`^@${escapeRegex(ASSISTANT_NAME)}\\b`, "i");

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const TANREN_API_URL = process.env.TANREN_API_URL || "";
