/**
 * MCP tools barrel — child stdio server entrypoint.
 *
 * Tool registrations live in `register-all.ts` so in-process providers
 * (Gemini) can share the same population step without booting a second
 * stdio server. This file is the script the Claude provider spawns via
 * `mcpServers` config; it imports the registrations, then starts the
 * MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import to `register-all.ts`. No
 * central list and no edits needed here.
 */
import './register-all.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
