#!/usr/bin/env npx tsx
/**
 * End-to-end test: runs the full container-runner pipeline with BoxLite.
 *
 * Tests the complete flow:
 *   1. BoxLite runtime init
 *   2. Box creation from agentlite-agent image
 *   3. Volume mounts
 *   4. stdin JSON piping
 *   5. Agent-runner compilation + execution
 *   6. stdout marker streaming
 *   7. Output parsing
 *
 * Usage:
 *   npx tsx scripts/test-boxlite-e2e.ts
 */
import fs from 'fs';
import path from 'path';

import { runContainerAgent, ContainerOutput } from '../src/container-runner.js';
import type { RegisteredGroup } from '../src/types.js';

// Ensure required directories exist
const projectRoot = process.cwd();
const testGroupDir = path.join(projectRoot, 'groups', 'e2e-test');
const dataDir = path.join(projectRoot, 'data');
fs.mkdirSync(testGroupDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

// Create a minimal CLAUDE.md for the test group
const claudeMd = path.join(testGroupDir, 'CLAUDE.md');
if (!fs.existsSync(claudeMd)) {
  fs.writeFileSync(claudeMd, '# E2E Test Group\nThis is a test group for BoxLite e2e testing.\n');
}

const testGroup: RegisteredGroup = {
  name: 'E2E Test',
  folder: 'e2e-test',
  trigger: '@test',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'What is 2 + 2? Reply with just the number, nothing else.',
  groupFolder: 'e2e-test',
  chatJid: 'e2e-test@test',
  isMain: false,
};

console.log('=== AgentLite BoxLite E2E Test ===\n');
console.log('Image:', process.env.BOX_IMAGE || 'ghcr.io/boxlite-ai/agentlite-agent:latest');
console.log('Prompt:', testInput.prompt);
console.log('');

const startTime = Date.now();
const streamedOutputs: ContainerOutput[] = [];

try {
  const result = await runContainerAgent(
    testGroup,
    testInput,
    (boxName, containerName) => {
      console.log(`Box created: ${containerName}`);
    },
    async (output: ContainerOutput) => {
      streamedOutputs.push(output);
      console.log(`[stream] status=${output.status} result=${output.result?.slice(0, 200) || '(null)'}`);
    },
  );

  const duration = Date.now() - startTime;
  console.log('');
  console.log('=== Result ===');
  console.log(`Status: ${result.status}`);
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log(`Session: ${result.newSessionId || '(none)'}`);
  console.log(`Streamed outputs: ${streamedOutputs.length}`);

  if (result.error) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  if (streamedOutputs.length === 0) {
    console.error('FAIL: No streamed outputs received');
    process.exit(1);
  }

  const hasResult = streamedOutputs.some((o) => o.result);
  if (!hasResult) {
    console.warn('WARN: No result text in streamed outputs (agent may have responded with tool use only)');
  }

  console.log('\nPASS: E2E test completed successfully');
} catch (err) {
  console.error('FATAL:', err);
  process.exit(1);
}
