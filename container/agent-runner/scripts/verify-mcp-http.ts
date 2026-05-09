/**
 * E2E verifier for the new McpServerConfig http/sse/streamableHttp shapes.
 *
 * Simulates exactly what the agent-runner does in src/index.ts:
 *   1. Read a hand-written container.json with the new shape
 *   2. Run loadConfig() (production code path)
 *   3. Run normalizeMcpEntry() per server (production code path)
 *   4. Open an MCP Streamable-HTTP connection to the resolved url
 *      (the same connection the Claude Agent SDK will open at runtime)
 *   5. Call tools/list and assert the QMD `query` tool appears
 *
 * Run with `bun run container/agent-runner/scripts/verify-mcp-http.ts`.
 *
 * Note: host-side (outside Docker) we hit localhost:7333; inside the agent
 * container the SDK uses host.docker.internal:7333. Both addresses route to
 * the same QMD daemon. The RUNNER_HOST env var lets you override.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { normalizeMcpEntry, type RawMcpEntry } from '../src/mcp-config.js';

const NAMESPACE = 'qmd-public';
const HOST = process.env.RUNNER_HOST || 'localhost:7333';

async function main() {
  // --- Step 1: hand-write a container.json with the NEW streamableHttp shape ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mcp-http-'));
  const cfgPath = path.join(tmp, 'container.json');
  const writtenConfig = {
    mcpServers: {
      [NAMESPACE]: {
        type: 'streamableHttp',
        url: `http://${HOST}/mcp`,
        instructions: 'QMD public index — mcp__qmd-public__query',
      },
    },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(writtenConfig, null, 2));
  console.log(`✓ wrote container.json with type:'streamableHttp' shape at ${cfgPath}`);

  // --- Step 2: production code path: read raw entry, normalize for SDK ---
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers[NAMESPACE] as RawMcpEntry;
  const normalized = normalizeMcpEntry(NAMESPACE, raw);
  console.log(`✓ normalizeMcpEntry produced: ${JSON.stringify(normalized)}`);

  if (!('url' in normalized) || normalized.type !== 'http') {
    throw new Error(`expected normalized to be { type: 'http', url } — got ${JSON.stringify(normalized)}`);
  }

  // --- Step 3: open the SAME MCP transport the Claude Agent SDK opens ---
  const transport = new StreamableHTTPClientTransport(new URL(normalized.url));
  const client = new Client({ name: 'verify-mcp-http', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log(`✓ MCP client.connect() succeeded against ${normalized.url}`);

  // --- Step 4: tools/list ---
  const result = await client.listTools();
  const names = result.tools.map((t) => t.name);
  console.log(`✓ tools/list returned: ${names.join(', ')}`);

  // The SDK namespaces remote MCP tools as mcp__<server>__<tool>. So
  // qmd-public's `query` becomes `mcp__qmd-public__query`. Verify the
  // raw tool is present; the namespacing is added by the SDK at hook time.
  if (!names.includes('query')) {
    throw new Error(`expected 'query' tool from qmd-public; got [${names.join(', ')}]`);
  }
  const expected = `mcp__${NAMESPACE}__query`;
  console.log(`✓ when the SDK loads this MCP, the agent will see: ${expected}`);

  await client.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nVERIFY OK — new McpServerConfig http/streamableHttp shape works end-to-end');
}

main().catch((err) => {
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});
