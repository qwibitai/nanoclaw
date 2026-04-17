import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ToolContext } from '../context.js';

import { buildRegisterGroupTool, buildSwitchModelTool } from './admin-tools.js';
import { buildSendMessageTool } from './message-tools.js';
import {
  buildCancelTaskTool,
  buildListTasksTool,
  buildPauseTaskTool,
  buildResumeTaskTool,
  buildScheduleTaskTool,
  buildUpdateTaskTool,
} from './task-tools.js';
import type { ToolDefinition } from './types.js';

/**
 * Build every tool definition. Returned in a predictable order so
 * `server.tool` is called the same way every invocation regardless
 * of module load order.
 */
export function buildAllTools(
  ctx: ToolContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Array<ToolDefinition<any, any>> {
  return [
    buildSendMessageTool(ctx),
    buildScheduleTaskTool(ctx),
    buildListTasksTool(ctx),
    buildPauseTaskTool(ctx),
    buildResumeTaskTool(ctx),
    buildCancelTaskTool(ctx),
    buildUpdateTaskTool(ctx),
    buildRegisterGroupTool(ctx),
    buildSwitchModelTool(ctx),
  ];
}

/** Register every NanoClaw tool onto an McpServer instance. */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  for (const tool of buildAllTools(ctx)) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool.handler as any,
    );
  }
}
