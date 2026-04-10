import { resolve } from '@std/path';
import { readEnvFile } from './env.ts';

const envConfig = readEnvFile([
  'ANTHROPIC_API_KEY',
  'ASSISTANT_NAME',
  'DISCORD_BOT_TOKEN',
  'GATEWAY_PORT',
  'GATEWAY_URL',
  'ONECLI_API_KEY',
  'OPERATOR_SLUG',
  'OPERATOR_NAME',
  'STORE_PORT',
  'STORE_URL',
  'SUPERMEMORY_API_KEY',
  'SUPERMEMORY_CONTAINER_TAG',
]);

const PROJECT_ROOT = Deno.cwd();

export const ASSISTANT_NAME =
  Deno.env.get('ASSISTANT_NAME') || envConfig.ASSISTANT_NAME || 'Nexus';

export const GATEWAY_PORT = parseInt(
  Deno.env.get('GATEWAY_PORT') || envConfig.GATEWAY_PORT || '3001',
  10,
);

export const GATEWAY_URL =
  Deno.env.get('GATEWAY_URL') || envConfig.GATEWAY_URL || 'http://localhost:3001';

export const OPERATOR_SLUG =
  Deno.env.get('OPERATOR_SLUG') || envConfig.OPERATOR_SLUG || 'ymir';

export const OPERATOR_NAME =
  Deno.env.get('OPERATOR_NAME') || envConfig.OPERATOR_NAME || 'Ymir';

export const ANTHROPIC_API_KEY =
  Deno.env.get('ANTHROPIC_API_KEY') || envConfig.ANTHROPIC_API_KEY || '';

// Set ONECLI_API_KEY in Deno.env so onecli.ts can read it
const onecliKey = Deno.env.get('ONECLI_API_KEY') || envConfig.ONECLI_API_KEY;
if (onecliKey) {
  Deno.env.set('ONECLI_API_KEY', onecliKey);
}

export const DISCORD_BOT_TOKEN =
  Deno.env.get('DISCORD_BOT_TOKEN') || envConfig.DISCORD_BOT_TOKEN || '';

// Operator data directory:
// - Local dev: ../nexus-data (workspace sibling)
// - Docker/Fly: /app/dev-data (baked into image by deploy script)
export const NEXUS_DATA_DIR =
  Deno.env.get('NEXUS_DATA_DIR') ||
  resolve(PROJECT_ROOT, '..', 'nexus-data');

export const SKILLS_DIR = resolve(PROJECT_ROOT, 'skills');
export const KNOWLEDGE_DIR = resolve(PROJECT_ROOT, 'knowledge');
export const OPERATORS_DIR = resolve(NEXUS_DATA_DIR, 'operators');
export const OPERATOR_DATA_DIR = resolve(OPERATORS_DIR, OPERATOR_SLUG);
export const SESSIONS_DIR = resolve(OPERATOR_DATA_DIR, 'sessions');
export const CONVERSATIONS_DIR = resolve(OPERATOR_DATA_DIR, 'conversations');

function readVersion(): string {
  try {
    const cfg = JSON.parse(
      Deno.readTextFileSync(resolve(PROJECT_ROOT, 'deno.json')),
    );
    return cfg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = readVersion();

export const WORKER_POLL_INTERVAL = 2000;

// Store process
export const STORE_PORT = parseInt(
  Deno.env.get('STORE_PORT') || envConfig.STORE_PORT || '3002',
  10,
);
export const STORE_URL =
  Deno.env.get('STORE_URL') || envConfig.STORE_URL || 'http://localhost:3002';
export const STORE_DIR =
  Deno.env.get('STORE_DIR') || resolve(OPERATOR_DATA_DIR, 'store');

// Supermemory — persistent agent memory across conversations.
// API key from console.supermemory.ai (scoped per operator).
// Container tag defaults to OPERATOR_SLUG but can be overridden
// (e.g., Ymir uses 'damonrand' not 'ymir').
export const SUPERMEMORY_API_KEY =
  Deno.env.get('SUPERMEMORY_API_KEY') || envConfig.SUPERMEMORY_API_KEY || '';
export const SUPERMEMORY_CONTAINER_TAG =
  Deno.env.get('SUPERMEMORY_CONTAINER_TAG') ||
  envConfig.SUPERMEMORY_CONTAINER_TAG ||
  OPERATOR_SLUG;

// Process isolation: gateway and agent use separate /tmp namespaces.
// They must NOT share filesystem state — all data flows through WorkItems.
// This mirrors Fly.io where they run on separate machines.
export const GATEWAY_TMP_DIR = '/tmp/nexus-gateway';
export const AGENT_TMP_DIR = '/tmp/nexus-agent';
export const WORKSPACE_DIR = resolve(AGENT_TMP_DIR, 'workspaces');
