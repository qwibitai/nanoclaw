import { describe, expect, it } from 'vitest';

import { buildSymphonyLaunchPlan } from './symphony-backends.js';

describe('buildSymphonyLaunchPlan', () => {
  it('builds a deterministic launch plan for a Symphony backend resolution', () => {
    const plan = buildSymphonyLaunchPlan({
      backend: 'claude-code',
      projectKey: 'nanoclaw',
      workspaceRoot: '/tmp/nanoclaw-symphony',
      secretScope: 'nanoclaw',
      reasons: ['project:nanoclaw', 'work_class:nanoclaw-core', 'backend:claude-code'],
      issueId: 'issue-1',
      issueIdentifier: 'NCL-42',
    });

    expect(plan).toEqual({
      backend: 'claude-code',
      bin: 'claude',
      argv: [],
      githubRepo: undefined,
      useWorktree: false,
      workspacePath: '/tmp/nanoclaw-symphony/NCL-42',
      env: {
        NANOCLAW_SYMPHONY_PROJECT_KEY: 'nanoclaw',
        NANOCLAW_SYMPHONY_SECRET_SCOPE: 'nanoclaw',
        NANOCLAW_SYMPHONY_ISSUE_ID: 'issue-1',
        NANOCLAW_SYMPHONY_ISSUE_IDENTIFIER: 'NCL-42',
        NANOCLAW_SYMPHONY_WORKSPACE_PATH: '/tmp/nanoclaw-symphony/NCL-42',
      },
    });
  });
});
