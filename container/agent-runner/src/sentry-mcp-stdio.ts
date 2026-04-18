/**
 * Sentry MCP Server (container-side proxy)
 *
 * Exposes Sentry tools to the agent via IPC bridge.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'sentry', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'sentry', 'responses');
const POLL_INTERVAL_MS = 100;
const TIMEOUT_MS = 30_000;

function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ipcRequest(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const requestId = generateRequestId();
  const requestFile = path.join(REQUESTS_DIR, `${requestId}.json`);
  const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);
  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
  const tempFile = `${requestFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify({ id: requestId, tool, args }));
  fs.renameSync(tempFile, requestFile);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      const raw = fs.readFileSync(responseFile, 'utf-8');
      fs.unlinkSync(responseFile);
      const response = JSON.parse(raw);
      if (response.error) throw new Error(response.error);
      return response.result;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Sentry IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`,
  );
}

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

const server = new McpServer({ name: 'sentry', version: '1.0.0' });

server.tool(
  'list_projects',
  'List all Sentry projects in the organization',
  {},
  async () => textResult(await ipcRequest('list_projects', {})),
);

server.tool(
  'list_issues',
  'List Sentry issues for a project',
  {
    project: z.string().describe('Sentry project slug'),
    query: z
      .string()
      .optional()
      .describe('Sentry search query (e.g. "is:unresolved")'),
    sort: z
      .enum(['date', 'freq', 'new', 'priority'])
      .optional()
      .describe('Sort order'),
    limit: z.number().optional().describe('Maximum number of issues'),
  },
  async (args) => textResult(await ipcRequest('list_issues', args)),
);

server.tool(
  'get_issue',
  'Get details for a single Sentry issue',
  {
    issue_id: z.string().describe('Sentry issue ID'),
    project: z.string().describe('Sentry project slug'),
  },
  async (args) => textResult(await ipcRequest('get_issue', args)),
);

server.tool(
  'get_events',
  'Get latest events/occurrences for a Sentry issue',
  {
    issue_id: z.string().describe('Sentry issue ID'),
    project: z.string().describe('Sentry project slug'),
    limit: z.number().optional().describe('Maximum number of events'),
  },
  async (args) => textResult(await ipcRequest('get_events', args)),
);

server.tool(
  'resolve_issue',
  'Mark a Sentry issue as resolved',
  {
    issue_id: z.string().describe('Sentry issue ID'),
    project: z.string().describe('Sentry project slug'),
  },
  async (args) => textResult(await ipcRequest('resolve_issue', args)),
);

server.tool(
  'ignore_issue',
  'Ignore a Sentry issue',
  {
    issue_id: z.string().describe('Sentry issue ID'),
    project: z.string().describe('Sentry project slug'),
  },
  async (args) => textResult(await ipcRequest('ignore_issue', args)),
);

server.tool(
  'assign_issue',
  'Assign a Sentry issue to a user',
  {
    issue_id: z.string().describe('Sentry issue ID'),
    project: z.string().describe('Sentry project slug'),
    assignee: z.string().describe('Email or username to assign to'),
  },
  async (args) => textResult(await ipcRequest('assign_issue', args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
