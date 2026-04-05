import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createProviderRegistry } from '../../provider-registry.js';

describe('codex host provider', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const tempRoot = tempRoots.pop();
      if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });

  it('prepares Codex AGENTS memory, a namespaced session home, and v1 capability flags', () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });
    const containerSpec = provider.buildContainerSpec({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      isMain: false,
      preparedSession,
    });

    // Assert
    expect(provider.capabilities).toEqual({
      persistentSessions: true,
      projectMemory: true,
      remoteControl: false,
      agentTeams: false,
      providerSkills: false,
    });
    expect(preparedSession.providerStateDir).toBe(
      path.join(dataDir, 'sessions', 'test-group', 'codex'),
    );
    expect(preparedSession.files).toEqual([
      {
        sourcePath: path.join(groupDir, 'AGENT.md'),
        targetPath: path.join(groupDir, 'AGENTS.md'),
      },
    ]);
    expect(preparedSession.directorySyncs).toBeUndefined();
    expect(containerSpec).toEqual({
      mounts: [
        {
          hostPath: path.join(dataDir, 'sessions', 'test-group', 'codex'),
          containerPath: '/home/node/.codex',
          readonly: false,
        },
      ],
      env: {
        CODEX_HOME: '/home/node/.codex',
      },
      workdir: '/workspace/group',
    });
  });

  it('returns an explicit unsupported result for remote control', async () => {
    // Arrange
    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const result = await provider.startRemoteControl?.({
      groupFolder: 'test-group',
      projectRoot: '/workspace/project',
      env: process.env,
      sender: 'user1',
      chatJid: 'test@g.us',
    });

    // Assert
    expect(result).toEqual({
      status: 'unsupported',
      message: 'Codex does not support remote control in NanoClaw v1.',
    });
  });
});
