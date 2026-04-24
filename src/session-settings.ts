/**
 * Session Settings for NanoClaw
 * Bootstraps Claude session configuration and compiles the agent-runner.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENT_CLI_BIN,
  AGENT_RUNNER_BACKEND,
  AUTO_COMPACT_ENABLED,
  AUTO_COMPACT_THRESHOLD,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  TIMEZONE,
} from './config.js';
import { buildProxySessionEnv } from './credentials.js';
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
  const hooksDir = path.join(process.cwd(), 'container', 'hooks');
  const serviceGuardHook = path.join(hooksDir, 'service-guard.sh');
  const toolObserverHook = path.join(hooksDir, 'tool-observer.sh');
  const defaultSettings: Record<string, unknown> = {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
  };

  // Build hooks configuration
  const hooks: Record<string, unknown[]> = {};

  if (fs.existsSync(serviceGuardHook)) {
    hooks.PreToolUse = [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: serviceGuardHook }],
      },
    ];
  }

  if (fs.existsSync(toolObserverHook)) {
    const toolObserverEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: toolObserverHook }],
    };
    hooks.PostToolUse = [toolObserverEntry];
    hooks.PostToolUseFailure = [toolObserverEntry];
  }

  if (Object.keys(hooks).length > 0) {
    defaultSettings.hooks = hooks;
  }

  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(defaultSettings, null, 2) + '\n',
    );
  } else {
    // Ensure existing settings have hooks up to date
    try {
      const existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      let needsWrite = false;

      // Case 1: No hooks at all — copy the entire hooks object
      if (!existing.hooks && defaultSettings.hooks) {
        existing.hooks = defaultSettings.hooks;
        needsWrite = true;
      } else if (existing.hooks && defaultSettings.hooks) {
        // Case 2: Has hooks, but may be missing some hook types
        const desired = defaultSettings.hooks as Record<string, unknown[]>;
        for (const [hookType, entries] of Object.entries(desired)) {
          if (!existing.hooks[hookType]) {
            existing.hooks[hookType] = entries;
            needsWrite = true;
          }
        }
      } else if (!existing.hooks && !defaultSettings.hooks) {
        // Case 3: Neither has hooks — no action needed
      } else if (existing.hooks && !defaultSettings.hooks) {
        // Case 4: Existing has hooks but default doesn't — preserve existing
      }

      if (needsWrite) {
        fs.writeFileSync(
          settingsFile,
          JSON.stringify(existing, null, 2) + '\n',
        );
        logger.debug(
          { groupFolder: path.basename(path.dirname(path.dirname(settingsFile))) },
          'Updated settings.json with missing hooks',
        );
      }
    } catch (err) {
      // Corrupted settings — log and leave as-is
      logger.warn(
        { err, settingsFile },
        'Failed to parse or update existing settings.json',
      );
    }
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
  Object.assign(
    env,
    buildProxySessionEnv(`http://127.0.0.1:${CREDENTIAL_PROXY_PORT}`),
  );

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

  // Provider-agnostic backend configuration
  env.AGENT_RUNNER_BACKEND = AGENT_RUNNER_BACKEND;
  env.AGENT_CLI_BIN = AGENT_CLI_BIN;

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
        { cause: err },
      );
    }
  }

  return distIndex;
}

/**
 * Update all existing group settings files to ensure they have the latest hooks.
 * Called once at startup to ensure tool-observer hooks are added to pre-existing sessions.
 */
export function updateAllGroupSettings(): void {
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;

  const hooksDir = path.join(process.cwd(), 'container', 'hooks');
  const toolObserverHook = path.join(hooksDir, 'tool-observer.sh');

  // Only proceed if tool-observer hook exists
  if (!fs.existsSync(toolObserverHook)) return;

  let updatedCount = 0;
  for (const groupFolder of fs.readdirSync(sessionsDir)) {
    const settingsFile = path.join(
      sessionsDir,
      groupFolder,
      '.claude',
      'settings.json',
    );
    if (!fs.existsSync(settingsFile)) continue;

    try {
      const existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

      // Check if PostToolUse or PostToolUseFailure hooks are missing
      const needsPostToolUse =
        !existing.hooks?.PostToolUse || !existing.hooks?.PostToolUseFailure;

      if (needsPostToolUse) {
        if (!existing.hooks) existing.hooks = {};

        const toolObserverEntry = {
          matcher: '',
          hooks: [{ type: 'command', command: toolObserverHook }],
        };

        existing.hooks.PostToolUse = [toolObserverEntry];
        existing.hooks.PostToolUseFailure = [toolObserverEntry];

        fs.writeFileSync(
          settingsFile,
          JSON.stringify(existing, null, 2) + '\n',
        );
        updatedCount++;
      }
    } catch (err) {
      logger.warn(
        { err, settingsFile },
        'Failed to update group settings.json',
      );
    }
  }

  if (updatedCount > 0) {
    logger.info(
      { updatedCount },
      'Updated existing group settings with tool-observer hooks',
    );
  }
}
