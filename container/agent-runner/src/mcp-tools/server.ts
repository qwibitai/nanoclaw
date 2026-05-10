/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 *
 * Spawn tools are mounted bifurcated via `mountSpawnTools()`:
 * - Orchestrator tools (spawn_task, list_spawned_tasks, spawn_cancel)
 *   when getSessionSpawnTaskId() === null AND agent has orchestrator capability
 * - Child tools (spawn_progress, spawn_complete, spawn_failed)
 *   when getSessionSpawnTaskId() !== null (Phase 1: mutually exclusive)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';
import { getSessionSpawnTaskId } from '../db/session-routing.js';
import { getCentralDb } from '../db/connection.js';
import { getConfig } from '../config.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function hasOrchestratorCapability(): boolean {
  let agentGroupId: string;
  try {
    agentGroupId = getConfig().agentGroupId;
  } catch {
    return false;
  }
  if (!agentGroupId) return false;

  const db = getCentralDb();
  if (!db) return false;

  try {
    const row = db
      .prepare(
        `SELECT 1 FROM agent_group_capabilities WHERE agent_group_id = ? AND role = 'orchestrator' LIMIT 1`,
      )
      .get(agentGroupId);
    return row != null;
  } catch {
    // Table may not exist on older installs — not an orchestrator
    return false;
  }
}

/**
 * Mount spawn tools bifurcated based on session role.
 *
 * Phase 1 simplification (acked in drift-acks.json entry B1):
 * orchestrator and child tool sets are mutually exclusive.
 *
 * Call this from the barrel (index.ts) after loadConfig() and before startMcpServer().
 */
export async function mountSpawnTools(): Promise<void> {
  const spawnTaskId = getSessionSpawnTaskId();

  if (spawnTaskId !== null) {
    // Child session — mount child tools
    const { spawnProgress, spawnComplete, spawnFailed } = await import('./dispatch-child.js');
    registerTools([spawnProgress, spawnComplete, spawnFailed]);
    log('Spawn: mounted child tools (spawn_progress, spawn_complete, spawn_failed)');
    return;
  }

  // Not a child session — check orchestrator capability
  if (hasOrchestratorCapability()) {
    const { spawnTask, listSpawnedTasks, spawnCancel } = await import('./dispatch.js');
    registerTools([spawnTask, listSpawnedTasks, spawnCancel]);
    log('Spawn: mounted orchestrator tools (spawn_task, list_spawned_tasks, spawn_cancel)');
  } else {
    log('Spawn: no spawn tools mounted (not orchestrator, not child)');
  }
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    return tool.handler(args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
