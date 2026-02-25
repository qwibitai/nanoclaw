#!/usr/bin/env npx tsx
/**
 * QA test: verifies the full IPC message flow end-to-end.
 *
 * Spawns the agent with a controlled stdin, sends an initial message,
 * waits for the response, then sends a follow-up (which goes through IPC),
 * and verifies the follow-up response arrives.
 *
 * Usage:
 *   npx tsx scripts/test-ipc-flow.ts
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const TIMEOUT_MS = 300_000; // 5 minutes total (container startup + 2 SDK queries)
const RESPONSE_WAIT_MS = 120_000; // 2 min per response (includes container cold-start)
const ASSISTANT_NAME = 'Andy';

interface TestResult {
  passed: boolean;
  message: string;
  responses: string[];
  errors: string[];
}

async function runTest(): Promise<TestResult> {
  const responses: string[] = [];
  const errors: string[] = [];
  let outputBuf = ''; // Combined stdout+stderr for ready detection

  console.log('[test] Starting agent process...');

  const agent = spawn('bun', ['run', 'dev'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOG_LEVEL: 'info' },
  });

  // Collect stdout — look for "Andy: <response>" lines
  agent.stdout.on('data', (data: Buffer) => {
    const text = data.toString();
    outputBuf += text;
    process.stdout.write(`[stdout] ${text}`);
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith(`${ASSISTANT_NAME}: `)) {
        responses.push(line.slice(ASSISTANT_NAME.length + 2).trim());
      }
    }
  });

  // Collect stderr for debugging
  agent.stderr.on('data', (data: Buffer) => {
    const text = data.toString();
    outputBuf += text;
    // Only print key log lines
    const lines = text.split('\n');
    for (const line of lines) {
      if (
        line.includes('Processing messages') ||
        line.includes('Spawning container') ||
        line.includes('Agent output') ||
        line.includes('Piped messages') ||
        line.includes('Container completed') ||
        line.includes('orphan') ||
        line.includes('owner') ||
        line.includes('IPC') ||
        line.includes('ipc') ||
        line.includes('Stopped') ||
        line.includes('Force-killed') ||
        line.includes('ERROR') ||
        line.includes('error') ||
        line.includes('Unprocessed')
      ) {
        console.log(`[agent] ${line.trim()}`);
      }
    }
  });

  // Wait for the agent to be ready (look for "running" in stdout or stderr)
  const ready = await Promise.race([
    new Promise<boolean>((resolve) => {
      const check = () => {
        if (outputBuf.includes('CamBot-Agent running')) {
          resolve(true);
        } else {
          setTimeout(check, 200);
        }
      };
      check();
    }),
    sleep(30_000).then(() => false),
  ]);

  if (!ready) {
    agent.kill();
    return { passed: false, message: 'Agent failed to start within 30s', responses, errors };
  }

  console.log('[test] Agent is ready. Sending initial message...');

  // Send initial message
  agent.stdin.write('who am i\n');

  // Wait for first response
  const gotFirst = await Promise.race([
    new Promise<boolean>((resolve) => {
      const check = () => {
        if (responses.length >= 1) {
          resolve(true);
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    }),
    sleep(RESPONSE_WAIT_MS).then(() => false),
  ]);

  if (!gotFirst) {
    agent.kill('SIGTERM');
    await sleep(2000);
    return { passed: false, message: 'No response to initial message within timeout', responses, errors };
  }

  console.log(`[test] Got first response (${responses.length} total). Waiting 3s then sending follow-up...`);
  await sleep(3000);

  // Send follow-up message (this goes through IPC)
  const followUpMsg = 'What is my wifes name?';
  console.log(`[test] Sending follow-up: "${followUpMsg}"`);
  agent.stdin.write(`${followUpMsg}\n`);

  const responseCountBefore = responses.length;

  // Wait for follow-up response
  const gotSecond = await Promise.race([
    new Promise<boolean>((resolve) => {
      const check = () => {
        if (responses.length > responseCountBefore) {
          resolve(true);
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    }),
    sleep(RESPONSE_WAIT_MS).then(() => false),
  ]);

  // Clean shutdown
  console.log('[test] Cleaning up...');
  agent.stdin.end();
  agent.kill('SIGTERM');
  await sleep(3000);

  if (!gotSecond) {
    return {
      passed: false,
      message: `IPC BUG: Follow-up message did not get a response. Got ${responses.length} responses total, expected > ${responseCountBefore}`,
      responses,
      errors,
    };
  }

  return {
    passed: true,
    message: `All responses received (${responses.length} total)`,
    responses,
    errors,
  };
}

// Run with global timeout
const globalTimeout = sleep(TIMEOUT_MS).then(() => {
  console.error('[test] GLOBAL TIMEOUT - killing everything');
  process.exit(2);
});

runTest().then((result) => {
  console.log('\n' + '='.repeat(60));
  console.log(`TEST ${result.passed ? 'PASSED' : 'FAILED'}: ${result.message}`);
  console.log('='.repeat(60));
  console.log('\nResponses received:');
  for (let i = 0; i < result.responses.length; i++) {
    console.log(`  [${i + 1}] ${result.responses[i].slice(0, 120)}...`);
  }
  if (result.errors.length > 0) {
    console.log('\nErrors:');
    for (const e of result.errors) console.log(`  - ${e}`);
  }
  process.exit(result.passed ? 0 : 1);
});
