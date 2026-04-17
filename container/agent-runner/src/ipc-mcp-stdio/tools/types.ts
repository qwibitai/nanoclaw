import type { ZodTypeAny } from 'zod';

/**
 * The pieces of an MCP tool we need to wire onto an McpServer via
 * `server.tool(name, description, schema, handler)`. Each factory
 * returns this shape so tests can invoke the handler directly
 * without spinning up a server + stdio transport.
 */
export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  schema: Record<string, ZodTypeAny>;
  handler: (args: TArgs) => Promise<TResult>;
}

/** Standard MCP text-only response helper. */
export function textResponse(
  text: string,
  isError = false,
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}
