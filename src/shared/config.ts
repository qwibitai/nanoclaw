import fs from 'fs';
import path from 'path';
import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'ANTHROPIC_API_KEY',
  'ASSISTANT_NAME',
  'GATEWAY_PORT',
  'GATEWAY_URL',
  'OPERATOR_SLUG',
  'OPERATOR_NAME',
]);

const PROJECT_ROOT = process.cwd();

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Nexus';

export const GATEWAY_PORT = parseInt(
  process.env.GATEWAY_PORT || envConfig.GATEWAY_PORT || '3001',
  10,
);

export const GATEWAY_URL =
  process.env.GATEWAY_URL || envConfig.GATEWAY_URL || 'http://localhost:3001';

export const OPERATOR_SLUG =
  process.env.OPERATOR_SLUG || envConfig.OPERATOR_SLUG || 'foundry';

export const OPERATOR_NAME =
  process.env.OPERATOR_NAME || envConfig.OPERATOR_NAME || 'Microgrid Foundry';

export const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || envConfig.ANTHROPIC_API_KEY || '';

export const DEV_DATA_DIR = path.resolve(PROJECT_ROOT, 'dev-data');
export const SKILLS_DIR = path.resolve(PROJECT_ROOT, 'skills');
export const KNOWLEDGE_DIR = path.resolve(PROJECT_ROOT, 'knowledge');
export const SESSIONS_DIR = path.resolve(DEV_DATA_DIR, 'sessions');
export const OPERATORS_DIR = path.resolve(DEV_DATA_DIR, 'operators');

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(PROJECT_ROOT, 'package.json'), 'utf-8'),
    );
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = readVersion();

export const WORKER_POLL_INTERVAL = 2000;
export const WORKSPACE_DIR = '/tmp/nexus-workspace';
