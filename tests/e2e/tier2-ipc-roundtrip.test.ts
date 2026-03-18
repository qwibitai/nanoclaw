/**
 * Tier 2 E2E: IPC round-trip with stub agent.
 *
 * INVARIANT: A message sent to the container via stdin produces a valid
 * response via stdout output markers. The full pipeline — entrypoint,
 * TypeScript compilation, SDK initialization, API call, result emission —
 * works end-to-end.
 *
 * SUT: Full agent pipeline with stub Anthropic API
 * VERIFICATION: Start stub server, run container, verify output markers.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { Server } from 'http';
import path from 'path';
import fs from 'fs';
import {
  startAgent,
  testContainerName,
  cleanupContainer,
  cleanupTmpDir,
  collectOutput,
  parseOutputMarkers,
} from './helpers.js';
import { startStubServer } from './stub-anthropic-server.js';

describe('Tier 2: IPC round-trip', () => {
  let stubServer: Server;
  let stubPort: number;
  const containers: string[] = [];
  const tmpDirs: string[] = [];

  beforeAll(async () => {
    const stub = await startStubServer({
      responseText: 'E2E test response from stub agent',
    });
    stubServer = stub.server;
    stubPort = stub.port;
  });

  afterAll(() => {
    stubServer?.close();
  });

  afterEach(() => {
    for (const name of containers) {
      cleanupContainer(name);
    }
    containers.length = 0;
    for (const dir of tmpDirs) {
      cleanupTmpDir(dir);
    }
    tmpDirs.length = 0;
  });

  it('agent produces a valid response via output markers', async () => {
    const containerName = testContainerName('e2e-roundtrip');
    containers.push(containerName);

    const input = {
      prompt: 'Say hello. Do not use any tools, just respond with text.',
      groupFolder: 'e2e_test',
      chatJid: 'e2e:test',
      isMain: true,
      assistantName: 'E2E Test Agent',
    };

    const { process: proc, tmpDir } = startAgent(
      containerName,
      input,
      stubPort,
    );
    tmpDirs.push(tmpDir);

    // Write close sentinel after a short delay so the agent exits after one turn
    setTimeout(() => {
      const closeFile = path.join(tmpDir, 'ipc', 'input', '_close');
      try {
        fs.writeFileSync(closeFile, '');
      } catch {
        // Container may have already exited
      }
    }, 5_000);

    const { stdout, stderr, exitCode } = await collectOutput(proc, 120_000);
    const outputs = parseOutputMarkers(stdout);

    // Should have at least one output
    expect(
      outputs.length,
      `No output markers found.\nstderr: ${stderr.slice(-500)}`,
    ).toBeGreaterThan(0);

    // First output should be successful
    const first = outputs[0];
    expect(first.status).toBe('success');
    expect(first.result).toBeTruthy();
  });
});
