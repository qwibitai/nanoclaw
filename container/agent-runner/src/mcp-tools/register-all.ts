/**
 * Side-effect module: imports each MCP tool module so its top-level
 * `registerTools([...])` call populates the in-process registry.
 *
 * Two distinct entrypoints depend on this file:
 *
 *  1. `index.ts` — the child MCP stdio server entrypoint. The Claude
 *     provider spawns this as a separate process and connects via
 *     `@modelcontextprotocol/sdk` stdio transport. Importing this file
 *     fills the registry that the stdio server's list/call handlers
 *     read from.
 *
 *  2. In-process providers (Gemini) — they import this file directly
 *     in their own module load to populate the registry inside the
 *     agent-runner host process, then call handlers via
 *     `getRegisteredToolByName(...)` without the JSON-RPC wire hop.
 *
 * This file deliberately has NO exports and NO `startMcpServer()` call,
 * so it's safe to import from either entrypoint without side effects
 * beyond filling the registry.
 */
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
// Baget customization (this fork) — exposes founder actions on a
// Baget company as MCP tools.
import './baget.js';
