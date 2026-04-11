/**
 * Stdio MCP Server for Vikunja.
 * Exposes the Vikunja v1 REST API as tools for the container agent.
 *
 * Auth:
 *   VIKUNJA_URL=http://<host>     (no trailing slash, e.g. http://vikunja:3456)
 *   VIKUNJA_TOKEN=<personal API token>
 *
 * The actual HTTP client lives in vikunja-api.ts so its functions can
 * be unit-tested without triggering this module's top-level
 * mcpServer.connect() side effect. This file is only the MCP wrapper.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  listProjects,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  listComments,
  addComment,
  getCurrentUser,
} from './vikunja-api.js';

function ok(data: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function err(e: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${e instanceof Error ? e.message : String(e)}`,
      },
    ],
    isError: true as const,
  };
}

// --- MCP Server ---

const mcpServer = new McpServer({ name: 'vikunja', version: '1.0.0' });

// --- Projects ---

mcpServer.tool(
  'vikunja_list_projects',
  'List all Vikunja projects the current token has access to. Returns project id, title, and description for each. Use this to discover the project_id values needed by vikunja_list_tasks and vikunja_create_task.',
  {},
  async () => {
    try {
      return ok(await listProjects());
    } catch (e) {
      return err(e);
    }
  },
);

// --- Tasks ---

mcpServer.tool(
  'vikunja_list_tasks',
  'List tasks in a Vikunja project. Returns id, title, description, done, due_date, priority, and assignees for each task. Use include_done=false to hide completed tasks.',
  {
    project_id: z
      .number()
      .int()
      .positive()
      .describe('Numeric Vikunja project id (discoverable via vikunja_list_projects).'),
    include_done: z
      .boolean()
      .optional()
      .describe('Include completed tasks. Default true. Set to false to only return open tasks.'),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Page number for paginated results, starting at 1.'),
  },
  async (args) => {
    try {
      return ok(await listTasks(args));
    } catch (e) {
      return err(e);
    }
  },
);

mcpServer.tool(
  'vikunja_get_task',
  'Get full details of a single Vikunja task by its numeric id. Returns all task fields including description, assignees, due_date, priority, and done state.',
  {
    task_id: z.number().int().positive().describe('Numeric Vikunja task id'),
  },
  async (args) => {
    try {
      return ok(await getTask(args.task_id));
    } catch (e) {
      return err(e);
    }
  },
);

mcpServer.tool(
  'vikunja_create_task',
  'Create a new task in a Vikunja project. Only project_id and title are required. Priority is 0–5 (0=none, 5=highest). Assignees must be Vikunja user ids — use vikunja_get_current_user to discover your own user id.',
  {
    project_id: z
      .number()
      .int()
      .positive()
      .describe('Numeric project id the task will be created in.'),
    title: z.string().min(1).describe('Task title (required, non-empty).'),
    description: z
      .string()
      .optional()
      .describe('Optional task description / body. Supports Markdown.'),
    due_date: z
      .string()
      .optional()
      .describe('Optional due date as an ISO8601 timestamp, e.g. "2026-04-15T09:00:00Z".'),
    priority: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe('Priority level 0–5 (0=none, 1=low, 5=highest).'),
    assignees: z
      .array(z.number().int().positive())
      .optional()
      .describe('Array of Vikunja user ids to assign the task to. Assigned via a follow-up API call after creation.'),
  },
  async (args) => {
    try {
      return ok(await createTask(args));
    } catch (e) {
      return err(e);
    }
  },
);

mcpServer.tool(
  'vikunja_update_task',
  'Update fields of an existing Vikunja task. Any field omitted is left unchanged. Set done=true to mark a task complete. Pass assignees to replace the full assignee list (empty array removes all assignees).',
  {
    task_id: z.number().int().positive().describe('Numeric task id to update.'),
    title: z.string().optional().describe('New task title.'),
    description: z.string().optional().describe('New task description.'),
    done: z
      .boolean()
      .optional()
      .describe('Mark the task done (true) or reopen it (false).'),
    due_date: z
      .string()
      .optional()
      .describe('New due date as an ISO8601 timestamp.'),
    priority: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe('New priority 0–5.'),
    assignees: z
      .array(z.number().int())
      .optional()
      .describe('Replace the full assignee list with these user ids. Pass [] to remove all assignees.'),
  },
  async (args) => {
    try {
      return ok(await updateTask(args));
    } catch (e) {
      return err(e);
    }
  },
);

mcpServer.tool(
  'vikunja_delete_task',
  'Delete a Vikunja task by its numeric id. Irreversible — use with care.',
  {
    task_id: z.number().int().positive().describe('Numeric task id to delete.'),
  },
  async (args) => {
    try {
      await deleteTask(args.task_id);
      return ok({ deleted: args.task_id });
    } catch (e) {
      return err(e);
    }
  },
);

// --- Comments ---

mcpServer.tool(
  'vikunja_list_comments',
  'List all comments on a Vikunja task. Returns comment id, body, author, and created timestamp.',
  {
    task_id: z.number().int().positive().describe('Numeric task id whose comments to list.'),
  },
  async (args) => {
    try {
      return ok(await listComments(args.task_id));
    } catch (e) {
      return err(e);
    }
  },
);

mcpServer.tool(
  'vikunja_add_comment',
  'Add a comment to a Vikunja task. Useful for leaving notes, status updates, or questions on tasks.',
  {
    task_id: z.number().int().positive().describe('Numeric task id to comment on.'),
    comment: z.string().min(1).describe('Comment body (required, non-empty). Supports Markdown.'),
  },
  async (args) => {
    try {
      return ok(await addComment(args.task_id, args.comment));
    } catch (e) {
      return err(e);
    }
  },
);

// --- Users ---

mcpServer.tool(
  'vikunja_get_current_user',
  'Get the Vikunja user account that owns the current API token. Returns id, username, and email. Call this once at the start of a session to discover your own user id — needed when assigning tasks to yourself via vikunja_create_task or vikunja_update_task.',
  {},
  async () => {
    try {
      return ok(await getCurrentUser());
    } catch (e) {
      return err(e);
    }
  },
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
