/**
 * Session Settings for NanoClaw
 * Bootstraps Claude session configuration and compiles the agent-runner.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AUTO_COMPACT_ENABLED,
  AUTO_COMPACT_THRESHOLD,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  TIMEZONE,
} from './config.js';
import { detectAuthMode } from './credential-proxy.js';
import { logger } from './logger.js';
import type { VolumeMount } from './container-runner.js';

/**
 * Bootstrap the Claude session settings directory for a group.
 * Creates the settings.json file and syncs skills.
 * Returns the host path to the session directory.
 */
export function bootstrapSessionSettings(groupFolder: string): string {
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  return groupSessionsDir;
}

/**
 * Build environment variables for the tmux session.
 * These replace the Docker -e flags and path-mapping volume mounts.
 */
export function buildSessionEnv(mounts: VolumeMount[]): Record<string, string> {
  const env: Record<string, string> = {};

  env.TZ = TIMEZONE;

  // Route API traffic through the credential proxy
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}`;

  // Auth mode placeholder (proxy handles real credentials)
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    env.ANTHROPIC_API_KEY = 'placeholder';
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = 'placeholder';
  }

  // Map volume mount paths to env vars for the agent-runner
  for (const mount of mounts) {
    if (mount.containerPath === '/workspace/group') {
      env.NANOCLAW_GROUP_DIR = mount.hostPath;
    } else if (mount.containerPath === '/workspace/global') {
      env.NANOCLAW_GLOBAL_DIR = mount.hostPath;
    } else if (mount.containerPath === '/workspace/ipc') {
      env.NANOCLAW_IPC_INPUT_DIR = path.join(mount.hostPath, 'input');
    } else if (mount.containerPath === '/home/node/.claude') {
      env.CLAUDE_CONFIG_DIR = mount.hostPath;
    } else if (mount.containerPath === '/workspace/extra') {
      env.NANOCLAW_EXTRA_DIR = mount.hostPath;
    }
  }

  // Auto-compact configuration
  if (AUTO_COMPACT_ENABLED) {
    env.AUTO_COMPACT_ENABLED = 'true';
    env.AUTO_COMPACT_THRESHOLD = String(AUTO_COMPACT_THRESHOLD);
  }

  return env;
}

/**
 * Ensure the agent-runner is compiled and ready to run on the host.
 * Returns the path to the compiled index.js.
 */
export function ensureAgentRunnerCompiled(): string {
  const projectRoot = process.cwd();
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');
  const distIndex = path.join(agentRunnerDir, 'dist', 'index.js');

  if (!fs.existsSync(distIndex)) {
    logger.info('Compiling agent-runner for host execution...');
    try {
      execSync('npm run build', {
        cwd: agentRunnerDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });
      logger.info('Agent-runner compiled successfully');
    } catch (err) {
      throw new Error(
        `Failed to compile agent-runner: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return distIndex;
}
