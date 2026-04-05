import { resolve } from '@std/path';
import { readEnvFile } from './env.ts';

const envConfig = readEnvFile([
  'ANTHROPIC_API_KEY',
  'ASSISTANT_NAME',
  'GATEWAY_PORT',
  'GATEWAY_URL',
  'OPERATOR_SLUG',
  'OPERATOR_NAME',
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
  Deno.env.get('OPERATOR_SLUG') || envConfig.OPERATOR_SLUG || 'foundry';

export const OPERATOR_NAME =
  Deno.env.get('OPERATOR_NAME') || envConfig.OPERATOR_NAME || 'Microgrid Foundry';

export const ANTHROPIC_API_KEY =
  Deno.env.get('ANTHROPIC_API_KEY') || envConfig.ANTHROPIC_API_KEY || '';

export const DEV_DATA_DIR = resolve(PROJECT_ROOT, 'dev-data');
export const SKILLS_DIR = resolve(PROJECT_ROOT, 'skills');
export const KNOWLEDGE_DIR = resolve(PROJECT_ROOT, 'knowledge');
export const SESSIONS_DIR = resolve(DEV_DATA_DIR, 'sessions');
export const OPERATORS_DIR = resolve(DEV_DATA_DIR, 'operators');

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
export const WORKSPACE_DIR = '/tmp/nexus-workspace';
