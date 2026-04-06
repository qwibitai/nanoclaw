import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createProviderRegistry } from '../../provider-registry.js';

describe('codex host provider', () => {
  const originalCodexAuthFile = process.env.CODEX_AUTH_FILE;
  const originalPath = process.env.PATH;
  const tempRoots: string[] = [];

  function installFakeCodexCli(
    tempRoot: string,
    statusesByAuthContents: Record<string, { status: number; text: string }>,
  ): void {
    const binDir = path.join(tempRoot, 'bin');
    const scriptPath = path.join(binDir, 'codex');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const authFile = path.join(process.env.CODEX_HOME || '', 'auth.json');
const content = fs.existsSync(authFile) ? fs.readFileSync(authFile, 'utf8') : '';
const statuses = ${JSON.stringify(statusesByAuthContents)};
const status = statuses[content] || { status: 1, text: 'Not logged in' };
process.stderr.write(status.text + '\\n');
process.exit(status.status);
`,
      { mode: 0o755 },
    );

    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  }

  afterEach(() => {
    if (originalCodexAuthFile === undefined) {
      delete process.env.CODEX_AUTH_FILE;
    } else {
      process.env.CODEX_AUTH_FILE = originalCodexAuthFile;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
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
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"auth":"chatgpt"}\n');
    process.env.CODEX_AUTH_FILE = authFile;
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
      {
        sourcePath: authFile,
        targetPath: path.join(
          dataDir,
          'sessions',
          'test-group',
          'codex',
          'auth.json',
        ),
      },
    ]);
    expect(preparedSession.allowedSourceRoots).toEqual([
      path.dirname(authFile),
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

  it('syncs refreshed auth.json back to the configured CODEX_AUTH_FILE after a run', async () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"refresh":"before"}\n');
    installFakeCodexCli(tempRoot, {
      '{"refresh":"after"}\n': {
        status: 0,
        text: 'Logged in using ChatGPT',
      },
    });
    process.env.CODEX_AUTH_FILE = authFile;

    const provider = createProviderRegistry().getProvider('codex');
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });
    fs.mkdirSync(preparedSession.providerStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(preparedSession.providerStateDir, 'auth.json'),
      '{"refresh":"after"}\n',
    );

    // Act
    await provider.finalizeSession?.({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
      preparedSession,
    });

    // Assert
    expect(fs.readFileSync(authFile, 'utf8')).toBe('{"refresh":"after"}\n');
  });

  it('does not overwrite a newer host auth.json that changed after session preparation', async () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"refresh":"before"}\n');
    installFakeCodexCli(tempRoot, {
      '{"refresh":"stale-session"}\n': {
        status: 0,
        text: 'Logged in using ChatGPT',
      },
    });
    process.env.CODEX_AUTH_FILE = authFile;

    const provider = createProviderRegistry().getProvider('codex');
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });
    fs.writeFileSync(authFile, '{"refresh":"newer"}\n');
    fs.mkdirSync(preparedSession.providerStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(preparedSession.providerStateDir, 'auth.json'),
      '{"refresh":"stale-session"}\n',
    );

    // Act
    await provider.finalizeSession?.({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
      preparedSession,
    });

    // Assert
    expect(fs.readFileSync(authFile, 'utf8')).toBe('{"refresh":"newer"}\n');
  });

  it('does not sync an invalid refreshed auth.json back to the configured CODEX_AUTH_FILE', async () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"refresh":"before"}\n');
    installFakeCodexCli(tempRoot, {
      '{"refresh":"invalid"}\n': {
        status: 1,
        text: 'Not logged in',
      },
    });
    process.env.CODEX_AUTH_FILE = authFile;

    const provider = createProviderRegistry().getProvider('codex');
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });
    fs.mkdirSync(preparedSession.providerStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(preparedSession.providerStateDir, 'auth.json'),
      '{"refresh":"invalid"}\n',
    );

    // Act
    await provider.finalizeSession?.({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
      preparedSession,
    });

    // Assert
    expect(fs.readFileSync(authFile, 'utf8')).toBe('{"refresh":"before"}\n');
  });

  it('preserves host auth.json permissions when syncing refreshed credentials', async () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"refresh":"before"}\n');
    fs.chmodSync(authFile, 0o600);
    installFakeCodexCli(tempRoot, {
      '{"refresh":"after"}\n': {
        status: 0,
        text: 'Logged in using ChatGPT',
      },
    });
    process.env.CODEX_AUTH_FILE = authFile;

    const provider = createProviderRegistry().getProvider('codex');
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });
    fs.mkdirSync(preparedSession.providerStateDir, { recursive: true });
    const refreshedAuthFile = path.join(
      preparedSession.providerStateDir,
      'auth.json',
    );
    fs.writeFileSync(refreshedAuthFile, '{"refresh":"after"}\n');
    fs.chmodSync(refreshedAuthFile, 0o644);

    // Act
    await provider.finalizeSession?.({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
      preparedSession,
    });

    // Assert
    expect(fs.readFileSync(authFile, 'utf8')).toBe('{"refresh":"after"}\n');
    expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
  });

  it('clears stale provider auth cache when the configured source auth file is missing', () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    const providerStateDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      'codex',
    );
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(providerStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(providerStateDir, 'auth.json'),
      '{"stale":true}\n',
    );
    process.env.CODEX_AUTH_FILE = authFile;

    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });

    // Assert
    expect(preparedSession.files).toEqual([
      {
        sourcePath: path.join(groupDir, 'AGENT.md'),
        targetPath: path.join(groupDir, 'AGENTS.md'),
      },
    ]);
    expect(fs.existsSync(path.join(providerStateDir, 'auth.json'))).toBe(false);
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
