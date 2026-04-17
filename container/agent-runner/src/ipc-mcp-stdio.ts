/**
 * Stdio MCP Server for NanoClaw
 *
 * Standalone process that agent-teams subagents can inherit. Reads
 * context from NANOCLAW_* environment variables, builds a ToolContext,
 * registers every NanoClaw tool on a fresh McpServer, then connects
 * to stdio.
 *
 * The tool handlers themselves live under `ipc-mcp-stdio/tools/*` so
 * they can be unit-tested without spinning up a stdio transport
 * (the previous monolithic layout was invisible to v8 coverage because
 * the test file spawned this module as a child process).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createToolContextFromEnv } from './ipc-mcp-stdio/context.js';
import { registerAllTools } from './ipc-mcp-stdio/tools/register.js';

// Re-export for consumers (tests, host-side integrations).
export { writeIpcFile } from './ipc-mcp-stdio/ipc-writer.js';
export {
  createToolContextFromEnv,
  type ToolContext,
} from './ipc-mcp-stdio/context.js';
export {
  validateCron,
  validateInterval,
  validateOnce,
  validateSchedule,
} from './ipc-mcp-stdio/schedule-validator.js';
export {
  buildAllTools,
  registerAllTools,
} from './ipc-mcp-stdio/tools/register.js';

const ctx = createToolContextFromEnv();
const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});
registerAllTools(server, ctx);

const transport = new StdioServerTransport();
await server.connect(transport);
