import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetContainerConfig = vi.fn();
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
}));

const mockGetAgentGroup = vi.fn();
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: (...args: unknown[]) => mockGetAgentGroup(...args),
}));

const mockGetSession = vi.fn();
vi.mock('../db/sessions.js', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

vi.mock('../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: vi.fn(),
}));

// Register a test command so dispatch has something to find
import { register } from './registry.js';

register({
  name: 'test-cmd',
  description: 'test command (non-group resource)',
  resource: 'test',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'groups-test',
  description: 'test command (groups resource)',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'general-cmd',
  description: 'test command (no resource, like help)',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'sessions-list',
  description: 'test command (sessions resource)',
  resource: 'sessions',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'destinations-list',
  description: 'test command (destinations resource)',
  resource: 'destinations',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'members-add',
  description: 'test command (members resource)',
  resource: 'members',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'wirings-list',
  description: 'test command (wirings resource — not allowed)',
  resource: 'wirings',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

// Commands that return data shaped like real resources (for post-handler filtering tests)
register({
  name: 'groups-list-data',
  description: 'returns mock group rows',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => [
    { id: 'g1', name: 'my-group' },
    { id: 'g2', name: 'other-group' },
  ],
});

register({
  name: 'sessions-get-data',
  description: 'returns a mock session row',
  resource: 'sessions',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({
    id: args.id,
    agent_group_id: (args as Record<string, unknown>).belongs_to ?? 'g1',
  }),
});

import { dispatch } from './dispatch.js';
import type { CallerContext } from './frame.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Helpers ---

function agentCtx(overrides?: Partial<Extract<CallerContext, { caller: 'agent' }>>): CallerContext {
  return {
    caller: 'agent',
    sessionId: 's1',
    agentGroupId: 'g1',
    messagingGroupId: 'mg1',
    ...overrides,
  };
}

// --- Tests ---

describe('CLI scope enforcement', () => {
  it('disabled: rejects all CLI requests from agent', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'disabled' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('disabled');
    }
  });

  it('group: auto-fills --id with caller agent group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { foo: 'bar' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBe('g1');
    }
  });

  it('group: rejects cross-group access', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { id: 'other-group' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('scoped');
    }
  });

  it('group: allows same-group id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { id: 'g1' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('group: blocks cli_scope escalation', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { cli_scope: 'global' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('cli_scope');
    }
  });

  it('group: blocks cli-scope escalation (hyphenated)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { 'cli-scope': 'global' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('group: blocks non-group resources', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('test');
    }
  });

  it('group: allows general commands with no resource (e.g. help)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'general-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('group: allows sessions, auto-fills --agent_group_id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'sessions-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.agent_group_id).toBe('g1');
      // --id should NOT be auto-filled for sessions (it's session UUID, not group)
      expect(data.echo.id).toBeUndefined();
    }
  });

  it('group: allows destinations, auto-fills --id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'destinations-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBe('g1');
    }
  });

  it('group: allows members, auto-fills --group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'members-add', args: { user: 'u1' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.group).toBe('g1');
    }
  });

  it('group: blocks non-whitelisted resources (wirings)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'wirings-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('wirings');
    }
  });

  it('group: rejects cross-group --agent_group_id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-list', args: { agent_group_id: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('group: rejects cross-group --group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'members-add', args: { user: 'u1', group: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('global: allows cross-group access', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { id: 'other-group' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('global: allows non-group resources', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('global: does not auto-fill --id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { foo: 'bar' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBeUndefined();
    }
  });

  it('defaults to group when cli_scope is missing', async () => {
    mockGetContainerConfig.mockReturnValue({});

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('host caller bypasses CLI scope enforcement', async () => {
    // No config check should happen for host callers
    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { id: 'any-group' } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  // --- Post-handler filtering ---

  it('group: groups list filters out other groups', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as Array<{ id: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('g1');
    }
  });

  it('group: sessions get rejects cross-group session', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-get-data', args: { id: 's-123', belongs_to: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('different agent group');
    }
  });

  it('group: sessions get allows own-group session', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-get-data', args: { id: 's-123', belongs_to: 'g1' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(true);
  });

  it('global: no post-handler filtering', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'groups-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as Array<{ id: string }>;
      expect(data).toHaveLength(2); // both groups returned
    }
  });
});
