import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  listTasks,
  createTask,
  updateTask,
  listProjects,
  getCurrentUser,
  deleteTask,
} from './vikunja-api.js';

// Minimal Response builder so we can stub fetch with a realistic shape
// without pulling in a full Response polyfill.
function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    headers: {
      get: () => 'text/plain',
    },
    text: async () => body,
    json: async () => body,
  } as unknown as Response;
}

describe('vikunja-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv('VIKUNJA_URL', 'http://vikunja.test');
    vi.stubEnv('VIKUNJA_TOKEN', 'test-token-123');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // --- Auth / config ---

  it('throws a clear error when VIKUNJA_URL is missing', async () => {
    vi.stubEnv('VIKUNJA_URL', '');
    await expect(listProjects()).rejects.toThrow(
      /VIKUNJA_URL and VIKUNJA_TOKEN must be set/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a clear error when VIKUNJA_TOKEN is missing', async () => {
    vi.stubEnv('VIKUNJA_TOKEN', '');
    await expect(listProjects()).rejects.toThrow(
      /VIKUNJA_URL and VIKUNJA_TOKEN must be set/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips a trailing slash from VIKUNJA_URL before hitting the API', async () => {
    vi.stubEnv('VIKUNJA_URL', 'http://vikunja.test/');
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await listProjects();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://vikunja.test/api/v1/projects');
  });

  it('sends bearer auth header on every request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await listProjects();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer test-token-123');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  // --- listTasks ---

  it('listTasks GETs the project tasks endpoint and returns the mapped task list', async () => {
    const serverResponse = [
      {
        id: 42,
        title: 'Write tests',
        description: 'cover vikunja-api',
        done: false,
        due_date: '2026-04-15T09:00:00Z',
        priority: 3,
        assignees: [{ id: 7, username: 'k2' }],
      },
      {
        id: 43,
        title: 'Ship it',
        done: false,
      },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(serverResponse));

    const result = await listTasks({ project_id: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://vikunja.test/api/v1/projects/1/tasks');
    expect(init.method).toBe('GET');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 42,
      title: 'Write tests',
      description: 'cover vikunja-api',
      done: false,
      due_date: '2026-04-15T09:00:00Z',
      priority: 3,
    });
    expect(result[0].assignees).toEqual([{ id: 7, username: 'k2' }]);
    expect(result[1]).toMatchObject({ id: 43, title: 'Ship it', done: false });
  });

  it('listTasks applies the done=false filter when include_done is false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await listTasks({ project_id: 1, include_done: false });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('filter=done+%3D+false');
  });

  it('listTasks omits the done filter when include_done is true or unset', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await listTasks({ project_id: 1, include_done: true });
    let [url] = fetchMock.mock.calls[0];
    expect(url).not.toContain('filter=');

    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await listTasks({ project_id: 1 });
    [url] = fetchMock.mock.calls[1];
    expect(url).not.toContain('filter=');
  });

  it('listTasks appends the page query param when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await listTasks({ project_id: 5, page: 3 });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('page=3');
    expect(url).toMatch(/\/projects\/5\/tasks\?/);
  });

  // --- createTask ---

  it('createTask PUTs to /projects/:id/tasks with title and optional fields', async () => {
    const serverTask = {
      id: 100,
      title: 'Buy milk',
      description: 'whole',
      done: false,
      due_date: '2026-04-16T12:00:00Z',
      priority: 2,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(serverTask));

    const result = await createTask({
      project_id: 1,
      title: 'Buy milk',
      description: 'whole',
      due_date: '2026-04-16T12:00:00Z',
      priority: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://vikunja.test/api/v1/projects/1/tasks');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      title: 'Buy milk',
      description: 'whole',
      due_date: '2026-04-16T12:00:00Z',
      priority: 2,
    });
    expect(result).toMatchObject({ id: 100, title: 'Buy milk' });
  });

  it('createTask calls the assignees endpoint then re-fetches the task', async () => {
    const createdTask = { id: 100, title: 'Assigned task', done: false };
    const refetchedTask = {
      id: 100,
      title: 'Assigned task',
      done: false,
      assignees: [
        { id: 7, username: 'k2' },
        { id: 9, username: 'gary' },
      ],
    };

    fetchMock
      .mockResolvedValueOnce(jsonResponse(createdTask)) // PUT /projects/1/tasks
      .mockResolvedValueOnce(jsonResponse({})) // PUT /tasks/100/assignees (user 7)
      .mockResolvedValueOnce(jsonResponse({})) // PUT /tasks/100/assignees (user 9)
      .mockResolvedValueOnce(jsonResponse(refetchedTask)); // GET /tasks/100

    const result = await createTask({
      project_id: 1,
      title: 'Assigned task',
      assignees: [7, 9],
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [, createInit] = fetchMock.mock.calls[0];
    expect(createInit.method).toBe('PUT');
    // Body should NOT contain assignees — those go via the separate endpoint
    expect(JSON.parse(createInit.body)).not.toHaveProperty('assignees');

    const [assignUrl1, assignInit1] = fetchMock.mock.calls[1];
    expect(assignUrl1).toBe('http://vikunja.test/api/v1/tasks/100/assignees');
    expect(assignInit1.method).toBe('PUT');
    expect(JSON.parse(assignInit1.body)).toEqual({ user_id: 7 });

    const [, assignInit2] = fetchMock.mock.calls[2];
    expect(JSON.parse(assignInit2.body)).toEqual({ user_id: 9 });

    const [refetchUrl, refetchInit] = fetchMock.mock.calls[3];
    expect(refetchUrl).toBe('http://vikunja.test/api/v1/tasks/100');
    expect(refetchInit.method).toBe('GET');

    expect(result.assignees).toHaveLength(2);
  });

  // --- updateTask ---

  it('updateTask POSTs partial fields to /tasks/:id and returns the updated task', async () => {
    const updatedTask = {
      id: 42,
      title: 'Write tests',
      done: true,
      priority: 3,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(updatedTask));

    const result = await updateTask({ task_id: 42, done: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://vikunja.test/api/v1/tasks/42');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ done: true });
    expect(result.done).toBe(true);
  });

  it('updateTask only sends fields that were explicitly provided', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 42, title: 'New title', done: false }),
    );

    await updateTask({ task_id: 42, title: 'New title' });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ title: 'New title' });
    expect(body).not.toHaveProperty('description');
    expect(body).not.toHaveProperty('done');
    expect(body).not.toHaveProperty('priority');
  });

  it('updateTask supports marking a task done (the common k2 workflow)', async () => {
    const before = {
      id: 42,
      title: 'Buy milk',
      done: false,
    };
    const after = {
      id: 42,
      title: 'Buy milk',
      done: true,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(after));

    const result = await updateTask({ task_id: 42, done: true });

    expect(result.done).toBe(true);
    expect(result.id).toBe(before.id);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ done: true });
  });

  // --- deleteTask ---

  it('deleteTask DELETEs /tasks/:id and returns without a body', async () => {
    // Simulate empty 204 response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      headers: { get: () => '' },
      text: async () => '',
      json: async () => null,
    } as unknown as Response);

    await expect(deleteTask(42)).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://vikunja.test/api/v1/tasks/42');
    expect(init.method).toBe('DELETE');
  });

  // --- getCurrentUser ---

  it('getCurrentUser GETs /user and returns the authenticated user', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 7, username: 'k2', email: 'k2@bitcryptic.com' }),
    );

    const user = await getCurrentUser();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://vikunja.test/api/v1/user');
    expect(init.method).toBe('GET');
    expect(user).toEqual({ id: 7, username: 'k2', email: 'k2@bitcryptic.com' });
  });

  // --- error propagation ---

  it('surfaces HTTP errors with status and body text', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));

    await expect(listTasks({ project_id: 1 })).rejects.toThrow(
      /HTTP 403 Forbidden/,
    );
  });
});
