/**
 * Shared helper for building the runtime MCP server configs carried in
 * ContainerInput. Lives outside message-processor so both the message
 * loop and the task scheduler can reuse it without cross-layer imports.
 *
 * Transforms user-facing McpServerConfig into container-ready runtime configs:
 * - Strips `source` (host path) — not needed at runtime
 * - For `node` commands: resolves entry file to the shared container MCP directory,
 *   injecting --experimental-transform-types for .ts files (Node 22+)
 * - For other commands (npx, python): passes args through unchanged
 */

import { CONTAINER_CUSTOM_MCP_DIR } from './backend-home.js';

// MCP sources are copied per-group into the shared container MCP directory.
// A host-created symlink node_modules → /app/node_modules resolves inside
// the container for ESM import resolution. Verified by e2e test.

export function buildMcpRuntimeConfig(
  mcpServers: Record<
    string,
    {
      source: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  > | null,
): Record<
  string,
  { command: string; args?: string[]; env?: Record<string, string> }
> | null {
  if (!mcpServers) return null;
  return Object.fromEntries(
    Object.entries(mcpServers).map(([name, cfg]) => {
      const mcpDir = `${CONTAINER_CUSTOM_MCP_DIR}/${name}`;
      const isNode = cfg.command === 'node';
      const entry = cfg.args?.[0];

      let args = cfg.args;
      if (isNode && entry && !entry.startsWith('/')) {
        const resolvedEntry = `${mcpDir}/${entry}`;
        const rest = cfg.args!.slice(1);
        args = entry.endsWith('.ts')
          ? ['--experimental-transform-types', resolvedEntry, ...rest]
          : [resolvedEntry, ...rest];
      }

      return [name, { command: cfg.command, args, env: cfg.env }];
    }),
  );
}
