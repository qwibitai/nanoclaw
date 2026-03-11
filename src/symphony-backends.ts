import path from 'node:path';

import type { SymphonyBackend, SymphonyBackendResolution } from './symphony-routing.js';

export type SymphonyLaunchPlan = {
  backend: SymphonyBackend;
  bin: string;
  argv: string[];
  workspacePath: string;
  env: Record<string, string>;
};

export type SymphonyLaunchInput = SymphonyBackendResolution & {
  issueId: string;
  issueIdentifier: string;
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
  const workspacePath = path.join(
    input.workspaceRoot,
    sanitizePathSegment(input.issueIdentifier),
  );

  return {
    backend: input.backend,
    bin: backendBinary(input.backend),
    argv: [],
    workspacePath,
    env: {
      NANOCLAW_SYMPHONY_PROJECT_KEY: input.projectKey,
      NANOCLAW_SYMPHONY_SECRET_SCOPE: input.secretScope,
      NANOCLAW_SYMPHONY_ISSUE_ID: input.issueId,
      NANOCLAW_SYMPHONY_ISSUE_IDENTIFIER: input.issueIdentifier,
      NANOCLAW_SYMPHONY_WORKSPACE_PATH: workspacePath,
    },
  };
}
