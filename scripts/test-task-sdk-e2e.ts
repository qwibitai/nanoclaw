#!/usr/bin/env npx tsx

import fs from 'fs';
import os from 'os';
import path from 'path';

import { createAgentLite } from '../src/api/sdk.js';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-task-e2e-'));
const anthropicToken =
  process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;

async function main(): Promise<void> {
  console.log('=== AgentLite Task SDK E2E ===');
  console.log(`Workdir: ${workdir}`);
  console.log(
    `Image: ${process.env.BOX_IMAGE || 'ghcr.io/boxlite-ai/agentlite-agent:latest'}`,
  );
  if (!anthropicToken) {
    throw new Error(
      'Missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY for container credentials',
    );
  }

  let platform = await createAgentLite({ workdir, timezone: 'UTC' });
  let agent = platform.getOrCreateAgent('main', {
    name: 'Andy',
    credentials: async () => ({
      ANTHROPIC_AUTH_TOKEN: anthropicToken,
      ANTHROPIC_API_KEY: anthropicToken,
      ...(anthropicBaseUrl ? { ANTHROPIC_BASE_URL: anthropicBaseUrl } : {}),
    }),
  });

  try {
    await agent.start();

    await agent.registerGroup('main@test', {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      isMain: true,
    });
    await agent.registerGroup('team@test', {
      name: 'Task E2E',
      folder: 'task_e2e',
      trigger: '@Andy',
    });

    const task = await agent.scheduleTask({
      jid: 'team@test',
      prompt: 'Reply with exactly: task sdk e2e ok',
      scheduleType: 'once',
      scheduleValue: '2024-01-01T00:00:00Z',
    });

    console.log(`Scheduled task ${task.id}`);
    console.log(
      'Restarting through a fresh AgentLite instance so the scheduler immediately rechecks due tasks...',
    );

    await platform.stop();
    platform = await createAgentLite({ workdir, timezone: 'UTC' });
    agent = platform.getOrCreateAgent('main', {
      name: 'Andy',
      credentials: async () => ({
        ANTHROPIC_AUTH_TOKEN: anthropicToken,
        ANTHROPIC_API_KEY: anthropicToken,
        ...(anthropicBaseUrl ? { ANTHROPIC_BASE_URL: anthropicBaseUrl } : {}),
      }),
    });
    await agent.start();

    const timeoutMs = 120_000;
    const pollIntervalMs = 1_000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const current = agent.getTask(task.id);
      if (current?.lastRun && current.runs.length > 0) {
        console.log('Task completed.');
        console.log(`Status: ${current.status}`);
        console.log(`Last run: ${current.lastRun}`);
        console.log(`Last result: ${current.lastResult}`);
        console.log(`Run count: ${current.runs.length}`);

        if (current.status !== 'completed') {
          throw new Error(`Expected completed status, got ${current.status}`);
        }
        if (current.runs.length < 1) {
          throw new Error('Expected at least one run log entry');
        }
        if (!current.lastRun) {
          throw new Error('Expected lastRun to be set');
        }

        console.log('PASS: Task SDK E2E completed successfully');
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Timed out waiting for task ${task.id} to complete`);
  } finally {
    await platform.stop();
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
