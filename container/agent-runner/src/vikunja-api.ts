/**
 * Vikunja REST API client.
 *
 * Pure module — no side effects, no MCP server bindings. Wrapped by
 * vikunja-mcp-stdio.ts which registers each function as an MCP tool.
 * Kept separate so tests can import and mock fetch() without spinning
 * up a stdio server (unlike the single-file homeassistant pattern).
 *
 * All functions read VIKUNJA_URL and VIKUNJA_TOKEN from process.env
 * at call time (not at module load) so tests can override them per
 * test with vi.stubEnv.
 *
 * API reference: https://vikunja.io/api/ (v1)
 */

// Base path segment for the Vikunja v1 REST API.
const API_PREFIX = '/api/v1';

/** Minimal Vikunja project shape returned by /projects. */
export interface VikunjaProject {
  id: number;
  title: string;
  description?: string;
}

/** Minimal Vikunja task shape returned by /projects/:id/tasks. */
export interface VikunjaTask {
  id: number;
  title: string;
  description?: string;
  done: boolean;
  due_date?: string;
  priority?: number;
  assignees?: Array<{ id: number; username?: string }>;
}

/** Comment shape returned by /tasks/:id/comments. */
export interface VikunjaComment {
  id: number;
  comment: string;
  author?: { id: number; username?: string };
  created?: string;
}

/** User shape returned by /user. */
export interface VikunjaUser {
  id: number;
  username: string;
  email?: string;
}

/** Create-task input. Mirrors the REST body shape but with camelCase where Vikunja uses camelCase too. */
export interface CreateTaskInput {
  project_id: number;
  title: string;
  description?: string;
  due_date?: string;
  priority?: number;
  assignees?: number[];
}

export interface UpdateTaskInput {
  task_id: number;
  title?: string;
  description?: string;
  done?: boolean;
  due_date?: string;
  priority?: number;
  assignees?: number[];
}

function requireConfig(): { base: string; token: string } {
  const base = (process.env.VIKUNJA_URL ?? '').replace(/\/$/, '');
  const token = process.env.VIKUNJA_TOKEN ?? '';
  if (!base || !token) {
    throw new Error('VIKUNJA_URL and VIKUNJA_TOKEN must be set');
  }
  return { base, token };
}

async function apiRequest<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const { base, token } = requireConfig();
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${API_PREFIX}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vikunja API ${method} ${path} failed: HTTP ${res.status} ${text}`);
  }
  // DELETE may return empty body
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// --- Projects ---

export async function listProjects(): Promise<VikunjaProject[]> {
  const raw = await apiRequest<VikunjaProject[]>('GET', '/projects');
  // Return only the fields we care about to keep tool output compact.
  return raw.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
  }));
}

// --- Tasks ---

export interface ListTasksOptions {
  project_id: number;
  include_done?: boolean;
  page?: number;
}

export async function listTasks(opts: ListTasksOptions): Promise<VikunjaTask[]> {
  const params = new URLSearchParams();
  if (opts.page != null) params.set('page', String(opts.page));
  // Vikunja filter syntax for hiding done tasks: done = false
  if (opts.include_done === false) {
    params.set('filter', 'done = false');
  }
  const qs = params.toString();
  const path = `/projects/${opts.project_id}/tasks${qs ? `?${qs}` : ''}`;
  const raw = await apiRequest<VikunjaTask[]>('GET', path);
  return raw.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    done: t.done,
    due_date: t.due_date,
    priority: t.priority,
    assignees: t.assignees,
  }));
}

export async function getTask(taskId: number): Promise<VikunjaTask> {
  return apiRequest<VikunjaTask>('GET', `/tasks/${taskId}`);
}

export async function createTask(input: CreateTaskInput): Promise<VikunjaTask> {
  const body: Record<string, unknown> = { title: input.title };
  if (input.description != null) body.description = input.description;
  if (input.due_date != null) body.due_date = input.due_date;
  if (input.priority != null) body.priority = input.priority;

  const task = await apiRequest<VikunjaTask>(
    'PUT',
    `/projects/${input.project_id}/tasks`,
    body,
  );

  // Vikunja assigns users via a separate endpoint after task creation.
  if (input.assignees && input.assignees.length > 0) {
    await Promise.all(
      input.assignees.map((userId) =>
        apiRequest('PUT', `/tasks/${task.id}/assignees`, { user_id: userId }),
      ),
    );
    // Re-fetch so the returned task reflects the assignees.
    return getTask(task.id);
  }

  return task;
}

export async function updateTask(input: UpdateTaskInput): Promise<VikunjaTask> {
  const body: Record<string, unknown> = {};
  if (input.title != null) body.title = input.title;
  if (input.description != null) body.description = input.description;
  if (input.done != null) body.done = input.done;
  if (input.due_date != null) body.due_date = input.due_date;
  if (input.priority != null) body.priority = input.priority;

  const task = await apiRequest<VikunjaTask>(
    'POST',
    `/tasks/${input.task_id}`,
    body,
  );

  // Assignees updated separately, same as createTask.
  if (input.assignees != null) {
    // Fetch existing, remove any that aren't in the new set, add missing ones.
    const existing = task.assignees ?? [];
    const existingIds = new Set(existing.map((a) => a.id));
    const targetIds = new Set(input.assignees);

    for (const a of existing) {
      if (!targetIds.has(a.id)) {
        await apiRequest('DELETE', `/tasks/${task.id}/assignees/${a.id}`);
      }
    }
    for (const userId of input.assignees) {
      if (!existingIds.has(userId)) {
        await apiRequest('PUT', `/tasks/${task.id}/assignees`, {
          user_id: userId,
        });
      }
    }
    return getTask(task.id);
  }

  return task;
}

export async function deleteTask(taskId: number): Promise<void> {
  await apiRequest('DELETE', `/tasks/${taskId}`);
}

// --- Comments ---

export async function listComments(taskId: number): Promise<VikunjaComment[]> {
  return apiRequest<VikunjaComment[]>('GET', `/tasks/${taskId}/comments`);
}

export async function addComment(
  taskId: number,
  comment: string,
): Promise<VikunjaComment> {
  return apiRequest<VikunjaComment>('PUT', `/tasks/${taskId}/comments`, {
    comment,
  });
}

// --- Users ---

export async function getCurrentUser(): Promise<VikunjaUser> {
  return apiRequest<VikunjaUser>('GET', '/user');
}
