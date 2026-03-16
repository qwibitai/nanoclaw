/**
 * NanoClaw Agent Runner - OpenCode SDK Version (STUB)
 *
 * This is a temporary stub to allow the container to build.
 * The full implementation requires significant refactoring to use
 * the OpenCode SDK's client-server architecture.
 *
 * OpenCode SDK Architecture:
 * - Uses HTTP client-server model, not direct function calls
 * - Requires running `opencode` server process
 * - Uses client.session.create() and client.session.chat() for interactions
 * - No direct equivalent to Claude Agent SDK's `query()` function with hooks
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // TODO: Implement OpenCode SDK integration
  // 1. Start opencode server process
  // 2. Connect using OpenCode client
  // 3. Create session and send message
  // 4. Stream responses back

  log('STUB: OpenCode SDK integration not yet implemented');

  writeOutput({
    status: 'success',
    result:
      'OpenCode SDK integration is being implemented. This is a temporary stub.',
    newSessionId: containerInput.sessionId || 'stub-session',
  });
}

main();
