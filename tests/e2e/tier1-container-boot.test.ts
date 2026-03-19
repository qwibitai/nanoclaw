/**
 * Tier 1 E2E: Container build, boot, and MCP tool registration.
 *
 * INVARIANT: The container image builds, boots, and registers all expected
 * MCP tools using pre-compiled dist/.
 *
 * SUT: container/build.sh → Dockerfile → ipc-mcp-stdio.ts
 * VERIFICATION: Build image, spawn MCP server, verify tool list matches contract.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  startMcpServer,
  testContainerName,
  cleanupContainer,
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

  it('container image exists', () => {
    // CI builds the image via docker/build-push-action before tests run.
    // Verify the image exists rather than rebuilding (kaizen #123).
    const result = execSync('docker image inspect nanoclaw-agent:latest', {
      stdio: 'pipe',
    });
    expect(result).toBeTruthy();
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

  it('pre-compiled dist/ exists in image and is loadable', async () => {
    const containerName = testContainerName('e2e-dist-check');
    containers.push(containerName);

    // Verify /app/dist/index.js exists and can be required (no runtime tsc needed)
    const proc = startMcpServer(containerName, {});
    try {
      const tools = await getMcpTools(proc);
      // If we got tools, the pre-compiled dist loaded successfully
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      proc.kill('SIGTERM');
    }
  });
});
