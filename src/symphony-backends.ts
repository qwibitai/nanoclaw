import os from 'node:os';
import path from 'node:path';

import type { SymphonyBackend, SymphonyBackendResolution } from './symphony-routing.js';

function expandHome(value: string): string {
  if (!value.startsWith('~')) {
    return value;
  }
  return path.join(os.homedir(), value.slice(1));
}

export type SymphonyLaunchPlan = {
  backend: SymphonyBackend;
  bin: string;
  argv: string[];
  workspacePath: string;
  useWorktree: boolean;
  githubRepo: string;
  env: Record<string, string>;
};

export type SymphonyLaunchInput = SymphonyBackendResolution & {
  issueId: string;
  issueIdentifier: string;
  githubRepo: string;
};

function sanitizePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function backendBinary(backend: SymphonyBackend): string {
  switch (backend) {
    case 'codex':
      return process.env.CODEX_BIN || 'codex';
    case 'claude-code':
      return process.env.CLAUDE_CODE_BIN || 'claude';
    case 'opencode-worker':
      return process.env.OPENCODE_BIN || 'opencode';
  }
}

export function buildSymphonyLaunchPlan(
  input: SymphonyLaunchInput,
): SymphonyLaunchPlan {
  const useWorktree = process.env.NANOCLAW_SYMPHONY_USE_WORKTREE === 'true';
  const expandedWorkspaceRoot = expandHome(input.workspaceRoot);
  const workspacePath = path.join(
    expandedWorkspaceRoot,
    sanitizePathSegment(input.issueIdentifier),
  );

  return {
    backend: input.backend,
    bin: backendBinary(input.backend),
    argv: [],
    workspacePath,
    useWorktree,
    githubRepo: input.githubRepo,
    env: {
      NANOCLAW_SYMPHONY_PROJECT_KEY: input.projectKey,
      NANOCLAW_SYMPHONY_SECRET_SCOPE: input.secretScope,
      NANOCLAW_SYMPHONY_ISSUE_ID: input.issueId,
      NANOCLAW_SYMPHONY_ISSUE_IDENTIFIER: input.issueIdentifier,
      NANOCLAW_SYMPHONY_WORKSPACE_PATH: workspacePath,
    },
  };
}
