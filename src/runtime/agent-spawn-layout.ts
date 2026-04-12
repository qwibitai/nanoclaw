import fs from 'fs';
import path from 'path';

import { AGENT_ROOT } from '../core/config.js';
import { logger } from '../core/logger.js';

const CLAUDE_SESSION_SETTINGS = {
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
};

const AGENT_RUNNER_SOURCE_DIR = path.join(process.cwd(), 'agent-runner');
const AGENT_RUNNER_RUNTIME_DIR = path.join(
  AGENT_ROOT,
  '.runtime',
  'agent-runner',
);
const AGENT_RUNNER_REQUIRED_FILES = [
  path.join('dist', 'index.js'),
  path.join('dist', 'ipc-mcp-stdio.js'),
  path.join(
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
    'package.json',
  ),
];

let lastRunnerSyncSignature: string | null = null;

function hasRequiredRunnerFiles(root: string): boolean {
  return AGENT_RUNNER_REQUIRED_FILES.every((relPath) =>
    fs.existsSync(path.join(root, relPath)),
  );
}

function statMtime(pathValue: string): string {
  try {
    return String(fs.statSync(pathValue).mtimeMs);
  } catch {
    return 'missing';
  }
}

function computeRunnerSourceSignature(sourceRoot: string): string {
  const signatureParts = [
    statMtime(path.join(sourceRoot, 'package-lock.json')),
    statMtime(path.join(sourceRoot, 'package.json')),
    statMtime(path.join(sourceRoot, 'dist', 'index.js')),
    statMtime(path.join(sourceRoot, 'dist', 'ipc-mcp-stdio.js')),
  ];
  return signatureParts.join('|');
}

/**
 * Ensure shared .claude/settings.json under AGENT_ROOT.
 * This is the single HOME for all agent processes.
 */
export function ensureSharedSessionSettings(): void {
  const claudeDir = path.join(AGENT_ROOT, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsFile = path.join(claudeDir, 'settings.json');

  let existingSettings: unknown = {};
  if (fs.existsSync(settingsFile)) {
    try {
      existingSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    } catch {
      existingSettings = {};
    }
  }

  const current =
    existingSettings && typeof existingSettings === 'object'
      ? (existingSettings as Record<string, unknown>)
      : {};
  const existingEnv =
    current.env && typeof current.env === 'object'
      ? (current.env as Record<string, unknown>)
      : {};
  const merged = {
    ...current,
    env: {
      ...existingEnv,
      ...CLAUDE_SESSION_SETTINGS.env,
    },
  };

  fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2) + '\n');
}

/**
 * Ensure AGENT_ROOT/.claude/skills/ exists as a real directory.
 * Skills are managed directly under this directory (single source of truth).
 * Legacy symlinks are migrated to real directories automatically.
 */
export function syncGroupSkills(): void {
  const skillsDst = path.join(AGENT_ROOT, '.claude', 'skills');

  // Migrate legacy symlink to a real directory
  try {
    const stat = fs.lstatSync(skillsDst);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(skillsDst);
    }
  } catch {
    // doesn't exist yet
  }

  fs.mkdirSync(skillsDst, { recursive: true });
}

export function getRepoAgentRunnerRoot(): string {
  return AGENT_RUNNER_SOURCE_DIR;
}

export function getRuntimeAgentRunnerRoot(): string {
  return AGENT_RUNNER_RUNTIME_DIR;
}

/**
 * Keep a runtime-local copy of host runner assets under AGENT_ROOT.
 * This avoids runtime dependence on `<repo>/container` or `<repo>/agent-runner`
 * paths after startup.
 */
export function syncHostAgentRunnerRuntime(): string {
  fs.mkdirSync(path.dirname(AGENT_RUNNER_RUNTIME_DIR), { recursive: true });

  // If source is unavailable, rely on already-synced runtime files.
  if (!fs.existsSync(AGENT_RUNNER_SOURCE_DIR)) {
    return AGENT_RUNNER_RUNTIME_DIR;
  }

  const sourceSignature = computeRunnerSourceSignature(AGENT_RUNNER_SOURCE_DIR);
  if (
    lastRunnerSyncSignature === sourceSignature &&
    hasRequiredRunnerFiles(AGENT_RUNNER_RUNTIME_DIR)
  ) {
    return AGENT_RUNNER_RUNTIME_DIR;
  }

  fs.cpSync(AGENT_RUNNER_SOURCE_DIR, AGENT_RUNNER_RUNTIME_DIR, {
    recursive: true,
    force: true,
  });
  lastRunnerSyncSignature = sourceSignature;
  logger.debug(
    { source: AGENT_RUNNER_SOURCE_DIR, destination: AGENT_RUNNER_RUNTIME_DIR },
    'Synchronized host agent-runner runtime assets',
  );
  return AGENT_RUNNER_RUNTIME_DIR;
}

export function ensureGroupIpcLayout(groupIpcDir: string): void {
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'memory-requests'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'memory-responses'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'permission-requests'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'permission-responses'), {
    recursive: true,
  });
}
