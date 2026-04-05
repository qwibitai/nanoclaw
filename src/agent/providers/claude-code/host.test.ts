import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createProviderRegistry } from '../../provider-registry.js';

const EXPECTED_CLAUDE_SETTINGS = {
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
};

describe('claude-code host provider', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const tempRoot = tempRoots.pop();
      if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });

  it('prepares Claude compatibility files, settings, and the Claude home mount', () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-claude-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    const provider = createProviderRegistry().getProvider('claude-code');

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
    const settingsPath = path.join(
      dataDir,
      'sessions',
      'test-group',
      'claude-code',
      'settings.json',
    );
    const settingsFile = preparedSession.files.find(
      (file) => file.targetPath === settingsPath,
    );

    // Assert
    expect(preparedSession.providerStateDir).toBe(
      path.join(dataDir, 'sessions', 'test-group', 'claude-code'),
    );
    expect(preparedSession.files).toEqual(
      expect.arrayContaining([
        {
          sourcePath: path.join(groupDir, 'AGENT.md'),
          targetPath: path.join(groupDir, 'CLAUDE.md'),
        },
        expect.objectContaining({
          targetPath: settingsPath,
        }),
      ]),
    );
    expect(settingsFile?.content).toBeDefined();
    expect(JSON.parse(settingsFile!.content!.trim())).toEqual(
      EXPECTED_CLAUDE_SETTINGS,
    );
    expect(preparedSession.directorySyncs).toEqual([
      {
        sourcePath: path.join(projectRoot, 'container', 'skills'),
        targetPath: path.join(
          dataDir,
          'sessions',
          'test-group',
          'claude-code',
          'skills',
        ),
      },
    ]);
    expect(containerSpec).toEqual({
      mounts: [
        {
          hostPath: path.join(dataDir, 'sessions', 'test-group', 'claude-code'),
          containerPath: '/home/node/.claude',
          readonly: false,
        },
      ],
      env: {},
      workdir: '/workspace/group',
    });
  });

  it('reuses legacy .claude state when the new provider namespace is empty', () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-claude-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const legacyStateDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      '.claude',
    );
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(legacyStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyStateDir, 'sessions-index.json'),
      JSON.stringify({ entries: [{ sessionId: 'legacy-session' }] }),
    );
    const provider = createProviderRegistry().getProvider('claude-code');

    // Act
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });

    // Assert
    expect(preparedSession.providerStateDir).toBe(legacyStateDir);
  });
});
