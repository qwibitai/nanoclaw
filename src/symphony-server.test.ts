import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startSymphonyServer } from './symphony-server.js';
import { writeRuntimeState } from './symphony-state.js';

const originalRegistryPath = process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH;

afterEach(() => {
  if (originalRegistryPath === undefined) {
    delete process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH;
  } else {
    process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH = originalRegistryPath;
  }
});

describe('symphony-server', () => {
  it('serves dashboard state from registry cache and runtime state', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-server-'));
    const registryPath = path.join(tempRoot, 'project-registry.cache.json');
    fs.writeFileSync(
      registryPath,
      `${JSON.stringify(
        {
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
        null,
        2,
      )}\n`,
      'utf8',
    );
    process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH = registryPath;
    writeRuntimeState({
      updatedAt: '2026-03-11T00:00:00.000Z',
      daemonHealthy: true,
      registryProjectCount: 1,
      enabledProjectCount: 1,
      projectReadyCounts: { nanoclaw: 2 },
      activeRunIds: [],
      projects: [
        {
          projectKey: 'nanoclaw',
          displayName: 'NanoClaw',
          symphonyEnabled: true,
          readyQueueCount: 2,
          activeRunCount: 0,
          lastRunStatus: 'idle',
        },
      ],
    });

    const server = await startSymphonyServer({
      port: 0,
      registryPath,
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server address unavailable');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as { registryProjectCount: number };
    expect(payload.registryProjectCount).toBe(1);
    server.close();
  });
});
