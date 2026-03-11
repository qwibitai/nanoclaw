import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildRuntimeState, buildRunId, listRunRecords, writeRunRecord } from './symphony-state.js';

const originalRegistryPath = process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH;

afterEach(() => {
  if (originalRegistryPath === undefined) {
    delete process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH;
  } else {
    process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH = originalRegistryPath;
  }
});

describe('symphony-state', () => {
  it('writes and lists run records', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-state-'));
    process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH = path.join(tempRoot, 'project-registry.cache.json');

    const runId = buildRunId('NCL-1', new Date('2026-03-11T00:00:00.000Z'));
    writeRunRecord({
      runId,
      projectKey: 'nanoclaw',
      issueId: 'issue-1',
      issueIdentifier: 'NCL-1',
      issueTitle: 'Test',
      linearIssueUrl: 'https://linear.app/issue/NCL-1',
      notionRoot: 'https://notion.so/root',
      githubRepo: 'ingpoc/nanoclaw',
      backend: 'codex',
      status: 'running',
      workspacePath: '/tmp/workspace',
      promptFile: '/tmp/workspace/PROMPT.md',
      manifestFile: '/tmp/workspace/RUN.json',
      logFile: '/tmp/workspace/run.log',
      exitFile: '/tmp/workspace/exit.json',
      pid: 123,
      startedAt: '2026-03-11T00:00:00.000Z',
    });

    const runs = listRunRecords();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe(runId);
  });

  it('builds runtime state from registry and runs', () => {
    const state = buildRuntimeState({
      registry: {
        schemaVersion: 1,
        projects: [
          {
            projectKey: 'nanoclaw',
            displayName: 'NanoClaw',
            linearProject: 'nanoclaw',
            notionRoot: 'https://notion.so/root',
            githubRepo: 'ingpoc/nanoclaw',
            symphonyEnabled: true,
            allowedBackends: ['codex'],
            defaultBackend: 'codex',
            workClassesSupported: ['nanoclaw-core'],
            secretScope: 'nanoclaw',
            workspaceRoot: '/tmp/workspace',
            readyPolicy: 'andy-developer-ready-v1',
          },
        ],
      },
      readyCounts: { nanoclaw: 2 },
      daemonHealthy: true,
      daemonPid: 999,
      runs: [
        {
          runId: 'run-1',
          projectKey: 'nanoclaw',
          issueId: 'issue-1',
          issueIdentifier: 'NCL-1',
          issueTitle: 'Test',
          linearIssueUrl: 'https://linear.app/issue/NCL-1',
          notionRoot: 'https://notion.so/root',
          githubRepo: 'ingpoc/nanoclaw',
          backend: 'codex',
          status: 'running',
          workspacePath: '/tmp/workspace',
          promptFile: '/tmp/workspace/PROMPT.md',
          manifestFile: '/tmp/workspace/RUN.json',
          logFile: '/tmp/workspace/run.log',
          exitFile: '/tmp/workspace/exit.json',
          pid: 123,
          startedAt: '2026-03-11T00:00:00.000Z',
        },
      ],
    });

    expect(state.registryProjectCount).toBe(1);
    expect(state.projects[0]?.readyQueueCount).toBe(2);
    expect(state.projects[0]?.activeRunCount).toBe(1);
    expect(state.activeRunIds).toEqual(['run-1']);
  });
});
