/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import { loadConfig } from '../config.js';
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import './thread-search.js';
import './git-worktrees.js';
import './tone-profiles.js';
import './remote-control.js';
import './capabilities.js';
import './permissions.js';
import './channel-config.js';
import './render-diagram.js';
import './backlog.js';
import { startMcpServer, mountDispatchTools } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

// MCP server runs in its own child process (spawned by the SDK over stdio),
// so the config cache populated by the agent-runner entry point isn't here.
// Tool handlers like backlog/thread-search read agentGroupId via getConfig(),
// which throws if loadConfig() hasn't been called — populate it before tools
// can be invoked.
loadConfig();

// Mount dispatch tools bifurcated (orchestrator vs child) then start the server.
mountDispatchTools()
  .then(() => startMcpServer())
  .catch((err) => {
    log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
