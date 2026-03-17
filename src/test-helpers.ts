import type { Case } from './cases.js';

/** Create a Case object for testing. Override any field via the overrides parameter. */
export function makeCase(overrides: Partial<Case> = {}): Case {
  const now = new Date().toISOString();
  return {
    id: `case-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    group_folder: 'test',
    chat_jid: 'tg:123',
    name: '260317-1200-test-case',
    description: 'Test case description',
    type: 'dev',
    status: 'active',
    blocked_on: null,
    worktree_path: null,
    workspace_path: '/tmp/test',
    branch_name: null,
    initiator: 'test',
    initiator_channel: null,
    last_message: null,
    last_activity_at: now,
    conclusion: null,
    created_at: now,
    done_at: null,
    reviewed_at: null,
    pruned_at: null,
    total_cost_usd: 0,
    token_source: null,
    time_spent_ms: 0,
    github_issue: null,
    ...overrides,
  };
}
