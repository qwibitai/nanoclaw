import path from 'path';

import { TIMEZONE } from '../config.js';
import type { ContainerInput } from '../container-runner.js';
import { readEnvFile } from '../env.js';
import type { RegisteredGroup } from '../types.js';

import { findClaudePath } from './claude-path.js';

export interface HostEnvPaths {
  ipcDir: string;
  groupDir: string;
  globalDir: string;
  extraDir: string;
  claudeHome: string;
}

/**
 * Build the environment variables passed to the host-mode agent process.
 * Kept pure (no filesystem writes, no spawning) so it's directly testable.
 */
export function buildEnvironment(
  _group: RegisteredGroup,
  input: ContainerInput,
  paths: HostEnvPaths,
): Record<string, string> {
  // Read auth credentials from .env — systemd doesn't load .env into process.env
  const dotenvAuth = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ]);

  // Ensure node/npx are on PATH (systemd may not have asdf/nvm paths)
  const nodeBinDir = path.dirname(process.execPath);
  const existingPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  const augmentedPath = existingPath.includes(nodeBinDir)
    ? existingPath
    : `${nodeBinDir}:${existingPath}`;

  return {
    ...(process.env as Record<string, string>),
    ...dotenvAuth,
    PATH: augmentedPath,
    TZ: TIMEZONE,
    // Agent-runner workspace paths (replaces container mount points)
    NANOCLAW_IPC_DIR: paths.ipcDir,
    NANOCLAW_GROUP_DIR: paths.groupDir,
    NANOCLAW_GLOBAL_DIR: paths.globalDir,
    NANOCLAW_EXTRA_DIR: paths.extraDir,
    // MCP server context
    NANOCLAW_CHAT_JID: input.chatJid,
    NANOCLAW_GROUP_FOLDER: input.groupFolder,
    NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
    // Use globally installed claude CLI in host mode
    CLAUDE_CODE_PATH: process.env.CLAUDE_CODE_PATH || findClaudePath(),
    // Claude SDK reads settings from this directory
    CLAUDE_CONFIG_DIR: paths.claudeHome,
  };
}
