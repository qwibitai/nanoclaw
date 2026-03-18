/**
 * Tier 1 E2E: Container build, boot, and MCP tool registration.
 *
 * INVARIANT: The container image builds, boots, compiles TypeScript,
 * and registers all expected MCP tools.
 *
 * SUT: container/build.sh → Dockerfile → entrypoint.sh → ipc-mcp-stdio.ts
 * VERIFICATION: Build image, spawn MCP server, verify tool list matches contract.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  buildContainer,
  startMcpServer,
  testContainerName,
  cleanupContainer,
  collectOutput,
  getMcpTools,
} from './helpers.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

// Tools that are conditionally registered (e.g., only for router group)
const CONDITIONAL_TOOLS = ['route_decision'];

function getExpectedTools(): string[] {
  const contract = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'contract.json'), 'utf-8'),
  );
  return (contract.surfaces.mcpTools as string[]).filter(
    (t) => !CONDITIONAL_TOOLS.includes(t),
  );
}

describe('Tier 1: Container build + boot', () => {
  const containers: string[] = [];

  afterEach(() => {
    for (const name of containers) {
      cleanupContainer(name);
    }
    containers.length = 0;
  });

  it('container image builds successfully', () => {
    expect(buildContainer()).toBe(true);
  });

  it('MCP server boots and registers all expected tools', async () => {
    const containerName = testContainerName('e2e-mcp');
    containers.push(containerName);

    const proc = startMcpServer(containerName);
    try {
      const tools = await getMcpTools(proc);
      const expected = getExpectedTools();

      // Every tool in contract.json must be registered
      for (const tool of expected) {
        expect(tools, `Missing MCP tool: ${tool}`).toContain(tool);
      }

      // No unexpected tools (catches unregistered additions)
      expect(tools.sort()).toEqual(expected.sort());
    } finally {
      proc.kill('SIGTERM');
    }
  });

  it('container entrypoint compiles TypeScript without errors', async () => {
    const containerName = testContainerName('e2e-compile');
    containers.push(containerName);

    // Run the entrypoint with a minimal input — it will compile TS then try to run
    // the agent (which will fail without API, but that's OK — we're checking compilation)
    const proc = startMcpServer(containerName, {});
    const { stderr } = await collectOutput(proc, 30_000);

    // Check for TypeScript compilation errors
    expect(stderr).not.toContain('error TS');
  });
});
