/**
 * Tool Plugin Interface for Sovereign
 * Each tool module exports a register function that conforms to this contract.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './tool-context.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export type RegisterFn = (server: McpServer, ctx: ToolContext) => void;
