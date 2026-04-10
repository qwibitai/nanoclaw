import { describe, expect, it, vi } from 'vitest';

import { ControlPlaneClient } from './control-plane-client.js';

describe('ControlPlaneClient', () => {
  it('sends the agent key and query params when fetching tasks', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify([{ id: 'task-1' }]),
    }));
    const client = new ControlPlaneClient({
      baseUrl: 'http://localhost:3000/',
      agentKey: 'agent_test',
      fetchImpl: fetchMock as any,
    });

    const tasks = await client.getTasks(true);

    expect(tasks).toEqual([{ id: 'task-1' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/agent/tasks?includeBacklog=true',
      expect.objectContaining({
        method: 'GET',
        headers: { 'x-agent-key': 'agent_test' },
      }),
    );
  });

  it('throws a useful error on non-2xx responses', async () => {
    const client = new ControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      agentKey: 'agent_test',
      fetchImpl: (async () => ({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: async () => JSON.stringify({ error: 'already claimed' }),
      })) as any,
    });

    await expect(
      client.updateTask('task-1', { claim: true, status: 'in-progress' }),
    ).rejects.toThrow(
      'Control plane PATCH /api/agent/tasks/task-1 failed: 409 already claimed',
    );
  });
});
