import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentProvider, PreparedSession } from './agent/provider-types.js';
import type { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

interface LoadedSubject {
  runContainerAgent: typeof import('./container-runner.js').runContainerAgent;
  spawnMock: ReturnType<typeof vi.fn>;
}

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: import('./container-runner.js').ContainerOutput,
): void {
  proc.stdout.push(
    `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
  );
}

async function loadSubject(
  provider: AgentProvider,
  dataDir: string,
  groupsDir: string,
  fakeProc: ReturnType<typeof createFakeProcess>,
): Promise<LoadedSubject> {
  const spawnMock = vi.fn(() => fakeProc);

  vi.resetModules();

  vi.doMock('./config.js', () => ({
    COMPATIBILITY_AGENT_PROVIDER: 'claude-code',
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    CONTAINER_MAX_OUTPUT_SIZE: 10485760,
    CONTAINER_TIMEOUT: 1800000,
    DATA_DIR: dataDir,
    GROUPS_DIR: groupsDir,
    IDLE_TIMEOUT: 1800000,
    ONECLI_URL: 'http://localhost:10254',
    TIMEZONE: 'UTC',
  }));

  vi.doMock('./logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  vi.doMock('./mount-security.js', () => ({
    validateAdditionalMounts: vi.fn(() => []),
  }));

  vi.doMock('./container-runtime.js', () => ({
    CONTAINER_RUNTIME_BIN: 'docker',
    hostGatewayArgs: () => [],
    readonlyMountArgs: (hostPath: string, containerPath: string) => [
      '-v',
      `${hostPath}:${containerPath}:ro`,
    ],
    stopContainer: vi.fn(),
  }));

  vi.doMock('./agent/provider-registry.js', () => ({
    createProviderRegistry: () => ({
      getProvider: (providerId: string) => {
        if (providerId !== provider.id) {
          throw new Error(`Unknown agent provider "${providerId}"`);
        }
        return provider;
      },
    }),
  }));

  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: class {
      applyContainerConfig = vi.fn().mockResolvedValue(true);
      createAgent = vi.fn().mockResolvedValue({ id: 'test' });
      ensureAgent = vi
        .fn()
        .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
    },
  }));

  vi.doMock('child_process', async () => {
    const actual =
      await vi.importActual<typeof import('child_process')>('child_process');
    return {
      ...actual,
      spawn: spawnMock,
    };
  });

  const module = await import('./container-runner.js');

  return {
    runContainerAgent: module.runContainerAgent,
    spawnMock,
  };
}

function createProviderGroup(providerId = 'codex'): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    providerId,
  };
}

function createPreparedSessionProvider(
  preparedSession: PreparedSession,
): AgentProvider {
  return {
    id: 'codex',
    displayName: 'Codex',
    capabilities: {
      persistentSessions: true,
      projectMemory: true,
      remoteControl: false,
      agentTeams: true,
      providerSkills: true,
    },
    validateHost() {
      return [];
    },
    prepareSession() {
      return preparedSession;
    },
    buildContainerSpec() {
      return {
        mounts: [],
        env: {},
        workdir: '/workspace/group',
      };
    },
    serializeRuntimeInput(ctx) {
      return {
        prompt: ctx.prompt,
        sessionId: ctx.sessionId,
        groupFolder: ctx.groupFolder,
        chatJid: ctx.chatJid,
        isMain: ctx.isMain,
      };
    },
  };
}

describe('container runner provider plumbing', () => {
  let tempRoot: string;
  let dataDir: string;
  let groupsDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-container-provider-test-'),
    );
    dataDir = path.join(tempRoot, 'data');
    groupsDir = path.join(tempRoot, 'groups');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('serializes provider runtime input, materializes provider files, and mounts the provider home inside approved roots', async () => {
    // Arrange
    const groupDir = path.join(groupsDir, 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'AGENT.md'), '# Canonical Agent\n');

    const providerStateDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      'codex',
    );
    const provider: AgentProvider = {
      id: 'codex',
      displayName: 'Codex',
      capabilities: {
        persistentSessions: true,
        projectMemory: true,
        remoteControl: false,
        agentTeams: true,
        providerSkills: true,
      },
      validateHost() {
        return [];
      },
      prepareSession() {
        return {
          providerStateDir,
          files: [
            {
              sourcePath: path.join(groupDir, 'AGENT.md'),
              targetPath: path.join(groupDir, 'AGENTS.md'),
            },
            {
              targetPath: path.join(providerStateDir, 'settings.json'),
              content: JSON.stringify({ provider: 'codex' }, null, 2) + '\n',
            },
          ],
          directorySyncs: [
            {
              sourcePath: path.join(process.cwd(), 'container', 'skills'),
              targetPath: path.join(providerStateDir, 'skills'),
            },
          ],
        };
      },
      buildContainerSpec(ctx) {
        return {
          mounts: [
            {
              hostPath: ctx.preparedSession.providerStateDir,
              containerPath: '/home/node/.codex',
              readonly: false,
            },
          ],
          env: {
            CODEX_HOME: '/home/node/.codex',
          },
          workdir: '/workspace/group',
        };
      },
      serializeRuntimeInput(ctx) {
        return {
          prompt: ctx.prompt,
          sessionId: ctx.sessionId,
          groupFolder: ctx.groupFolder,
          chatJid: ctx.chatJid,
          isMain: ctx.isMain,
          assistantName: ctx.assistantName,
          providerData: {
            mode: 'provider-owned',
          },
        };
      },
    };
    const fakeProc = createFakeProcess();
    let stdinPayload = '';
    fakeProc.stdin.on('data', (chunk) => {
      stdinPayload += chunk.toString();
    });

    const { runContainerAgent, spawnMock } = await loadSubject(
      provider,
      dataDir,
      groupsDir,
      fakeProc,
    );

    const group: RegisteredGroup = {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      providerId: 'codex',
    };

    // Act
    const resultPromise = runContainerAgent(
      group,
      {
        prompt: 'Ship the provider slice.',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        assistantName: 'Andy',
      },
      () => {},
    );

    await new Promise((resolve) => setImmediate(resolve));
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'done',
      newSessionId: 'session-123',
    });
    fakeProc.emit('close', 0);

    const result = await resultPromise;

    // Assert
    const serializedInput = JSON.parse(stdinPayload) as {
      providerId: string;
      runtimeInput: Record<string, unknown>;
    };
    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    const copiedRunnerDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      'agent-runner-src',
    );

    expect(result).toEqual({
      status: 'success',
      result: 'done',
      newSessionId: 'session-123',
    });
    expect(serializedInput).toEqual({
      providerId: 'codex',
      runtimeInput: {
        prompt: 'Ship the provider slice.',
        sessionId: undefined,
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        assistantName: 'Andy',
        providerData: {
          mode: 'provider-owned',
        },
      },
    });
    expect(fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8')).toBe(
      '# Canonical Agent\n',
    );
    expect(
      fs.readFileSync(path.join(providerStateDir, 'settings.json'), 'utf-8'),
    ).toContain('"provider": "codex"');
    expect(
      fs.existsSync(
        path.join(providerStateDir, 'skills', 'status', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(copiedRunnerDir, 'providers'))).toBe(true);
    expect(spawnArgs).toContain(`CODEX_HOME=/home/node/.codex`);
    expect(spawnArgs).toContain(`${providerStateDir}:/home/node/.codex`);
    expect(spawnArgs).toContain(`${copiedRunnerDir}:/app/src`);
  });

  it('runs provider session finalization after the container exits', async () => {
    // Arrange
    const groupDir = path.join(groupsDir, 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    const providerStateDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      'codex',
    );
    const finalizeSession = vi.fn();
    const provider: AgentProvider = {
      id: 'codex',
      displayName: 'Codex',
      capabilities: {
        persistentSessions: true,
        projectMemory: true,
        remoteControl: false,
        agentTeams: false,
        providerSkills: false,
      },
      validateHost() {
        return [];
      },
      prepareSession() {
        return {
          providerStateDir,
          files: [],
        };
      },
      buildContainerSpec() {
        return {
          mounts: [],
          env: {},
          workdir: '/workspace/group',
        };
      },
      serializeRuntimeInput(ctx) {
        return {
          prompt: ctx.prompt,
          sessionId: ctx.sessionId,
          groupFolder: ctx.groupFolder,
          chatJid: ctx.chatJid,
          isMain: ctx.isMain,
        };
      },
      finalizeSession,
    };
    const fakeProc = createFakeProcess();
    const { runContainerAgent } = await loadSubject(
      provider,
      dataDir,
      groupsDir,
      fakeProc,
    );

    // Act
    const resultPromise = runContainerAgent(
      createProviderGroup(),
      {
        prompt: 'Ship the provider slice.',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );

    await new Promise((resolve) => setImmediate(resolve));
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'done',
      newSessionId: 'session-123',
    });
    fakeProc.emit('close', 0);

    const result = await resultPromise;

    // Assert
    expect(result).toEqual({
      status: 'success',
      result: 'done',
      newSessionId: 'session-123',
    });
    expect(finalizeSession).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
      preparedSession: {
        providerStateDir,
        files: [],
      },
    });
  });

  it('does not run provider session finalization after an error result', async () => {
    // Arrange
    const groupDir = path.join(groupsDir, 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    const providerStateDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      'codex',
    );
    const finalizeSession = vi.fn();
    const provider: AgentProvider = {
      id: 'codex',
      displayName: 'Codex',
      capabilities: {
        persistentSessions: true,
        projectMemory: true,
        remoteControl: false,
        agentTeams: false,
        providerSkills: false,
      },
      validateHost() {
        return [];
      },
      prepareSession() {
        return {
          providerStateDir,
          files: [],
        };
      },
      buildContainerSpec() {
        return {
          mounts: [],
          env: {},
          workdir: '/workspace/group',
        };
      },
      serializeRuntimeInput(ctx) {
        return {
          prompt: ctx.prompt,
          sessionId: ctx.sessionId,
          groupFolder: ctx.groupFolder,
          chatJid: ctx.chatJid,
          isMain: ctx.isMain,
        };
      },
      finalizeSession,
    };
    const fakeProc = createFakeProcess();
    const { runContainerAgent } = await loadSubject(
      provider,
      dataDir,
      groupsDir,
      fakeProc,
    );

    // Act
    const resultPromise = runContainerAgent(
      createProviderGroup(),
      {
        prompt: 'Ship the provider slice.',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );

    await new Promise((resolve) => setImmediate(resolve));
    emitOutputMarker(fakeProc, {
      status: 'error',
      result: null,
      error: 'provider failed',
    });
    fakeProc.emit('close', 0);

    const result = await resultPromise;

    // Assert
    expect(result).toEqual({
      status: 'error',
      result: null,
      error: 'provider failed',
    });
    expect(finalizeSession).not.toHaveBeenCalled();
  });

  it('preserves provider files that are marked onlyIfMissing', async () => {
    // Arrange
    const groupDir = path.join(groupsDir, 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const providerStateDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      'codex',
    );
    fs.mkdirSync(providerStateDir, { recursive: true });
    const existingSettings = path.join(providerStateDir, 'settings.json');
    fs.writeFileSync(existingSettings, '{"provider":"custom"}\n');

    const provider = createPreparedSessionProvider({
      providerStateDir,
      files: [
        {
          targetPath: existingSettings,
          content: '{"provider":"seeded"}\n',
          onlyIfMissing: true,
        },
      ],
    });
    const fakeProc = createFakeProcess();
    const { runContainerAgent } = await loadSubject(
      provider,
      dataDir,
      groupsDir,
      fakeProc,
    );

    // Act
    const resultPromise = runContainerAgent(
      createProviderGroup(),
      {
        prompt: 'Ship the provider slice.',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );

    await new Promise((resolve) => setImmediate(resolve));
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
    });
    fakeProc.emit('close', 0);
    await resultPromise;

    // Assert
    expect(fs.readFileSync(existingSettings, 'utf-8')).toBe(
      '{"provider":"custom"}\n',
    );
  });

  it('materializes provider files from explicitly allowed external source roots', async () => {
    // Arrange
    const groupDir = path.join(groupsDir, 'test-group');
    const externalAuthRoot = path.join(tempRoot, 'external-auth');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(externalAuthRoot, { recursive: true });

    const providerStateDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      'codex',
    );
    const authSourceFile = path.join(externalAuthRoot, 'auth.json');
    fs.writeFileSync(authSourceFile, '{"auth":"chatgpt"}\n');

    const provider = createPreparedSessionProvider({
      providerStateDir,
      allowedSourceRoots: [externalAuthRoot],
      files: [
        {
          sourcePath: authSourceFile,
          targetPath: path.join(providerStateDir, 'auth.json'),
        },
      ],
    });
    const fakeProc = createFakeProcess();
    const { runContainerAgent } = await loadSubject(
      provider,
      dataDir,
      groupsDir,
      fakeProc,
    );

    // Act
    const resultPromise = runContainerAgent(
      createProviderGroup(),
      {
        prompt: 'Ship the provider slice.',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );

    await new Promise((resolve) => setImmediate(resolve));
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
    });
    fakeProc.emit('close', 0);
    await resultPromise;

    // Assert
    expect(
      fs.readFileSync(path.join(providerStateDir, 'auth.json'), 'utf-8'),
    ).toBe('{"auth":"chatgpt"}\n');
  });

  it('preserves the cached agent runner source when the project copy is unchanged', async () => {
    // Arrange
    const groupDir = path.join(groupsDir, 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const providerStateDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      'codex',
    );
    const copiedRunnerDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      'agent-runner-src',
    );
    fs.mkdirSync(copiedRunnerDir, { recursive: true });
    const cachedIndex = path.join(copiedRunnerDir, 'index.ts');
    fs.writeFileSync(cachedIndex, '// customized runner\n');

    const sourceIndex = path.join(
      process.cwd(),
      'container',
      'agent-runner',
      'src',
      'index.ts',
    );
    const newerCachedDate = new Date(fs.statSync(sourceIndex).mtimeMs + 10_000);
    fs.utimesSync(cachedIndex, newerCachedDate, newerCachedDate);

    const provider = createPreparedSessionProvider({
      providerStateDir,
      files: [],
    });
    const fakeProc = createFakeProcess();
    const { runContainerAgent } = await loadSubject(
      provider,
      dataDir,
      groupsDir,
      fakeProc,
    );

    // Act
    const resultPromise = runContainerAgent(
      createProviderGroup(),
      {
        prompt: 'Ship the provider slice.',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );

    await new Promise((resolve) => setImmediate(resolve));
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
    });
    fakeProc.emit('close', 0);
    await resultPromise;

    // Assert
    expect(fs.readFileSync(cachedIndex, 'utf-8')).toBe(
      '// customized runner\n',
    );
  });

  it('rejects provider mounts that escape the current group workspace or provider session namespace', async () => {
    // Arrange
    const providerStateDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      'codex',
    );
    const provider: AgentProvider = {
      id: 'codex',
      displayName: 'Codex',
      capabilities: {
        persistentSessions: true,
        projectMemory: true,
        remoteControl: false,
        agentTeams: true,
        providerSkills: false,
      },
      validateHost() {
        return [];
      },
      prepareSession() {
        return {
          providerStateDir,
          files: [],
        };
      },
      buildContainerSpec() {
        return {
          mounts: [
            {
              hostPath: process.cwd(),
              containerPath: '/home/node/.codex',
              readonly: false,
            },
          ],
          env: {},
        };
      },
      serializeRuntimeInput(ctx) {
        return {
          prompt: ctx.prompt,
          sessionId: ctx.sessionId,
          groupFolder: ctx.groupFolder,
          chatJid: ctx.chatJid,
          isMain: ctx.isMain,
        };
      },
    };
    const fakeProc = createFakeProcess();
    const { runContainerAgent, spawnMock } = await loadSubject(
      provider,
      dataDir,
      groupsDir,
      fakeProc,
    );
    const group: RegisteredGroup = {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      providerId: 'codex',
    };

    // Act
    const run = runContainerAgent(
      group,
      {
        prompt: 'Ship the provider slice.',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );

    // Assert
    await expect(run).rejects.toThrow(
      'Provider mount host path must stay within the group workspace or provider session namespace',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'provider file targets',
      buildPreparedSession: (
        groupDir: string,
        providerStateDir: string,
        outsideRoot: string,
      ): PreparedSession => ({
        providerStateDir,
        files: [
          {
            targetPath: path.join(outsideRoot, 'escaped-target.md'),
            content: '# escaped\n',
          },
        ],
      }),
      expectedError:
        'Provider file target must stay within the group workspace or provider session namespace',
    },
    {
      name: 'provider file sources',
      buildPreparedSession: (
        groupDir: string,
        providerStateDir: string,
        outsideRoot: string,
      ): PreparedSession => ({
        providerStateDir,
        files: [
          {
            sourcePath: path.join(outsideRoot, 'escaped-source.md'),
            targetPath: path.join(groupDir, 'AGENTS.md'),
          },
        ],
      }),
      setupOutsideRoot: (outsideRoot: string) => {
        fs.mkdirSync(outsideRoot, { recursive: true });
        fs.writeFileSync(
          path.join(outsideRoot, 'escaped-source.md'),
          '# escaped\n',
        );
      },
      expectedError: 'Provider file source must stay within approved roots',
    },
    {
      name: 'provider directory sync targets',
      buildPreparedSession: (
        groupDir: string,
        providerStateDir: string,
        outsideRoot: string,
      ): PreparedSession => ({
        providerStateDir,
        files: [],
        directorySyncs: [
          {
            sourcePath: path.join(process.cwd(), 'container', 'skills'),
            targetPath: path.join(outsideRoot, 'skills'),
          },
        ],
      }),
      expectedError:
        'Provider directory target must stay within the group workspace or provider session namespace',
    },
    {
      name: 'provider directory sync sources',
      buildPreparedSession: (
        groupDir: string,
        providerStateDir: string,
        outsideRoot: string,
      ): PreparedSession => ({
        providerStateDir,
        files: [],
        directorySyncs: [
          {
            sourcePath: path.join(outsideRoot, 'skills'),
            targetPath: path.join(providerStateDir, 'skills'),
          },
        ],
      }),
      setupOutsideRoot: (outsideRoot: string) => {
        fs.mkdirSync(path.join(outsideRoot, 'skills'), { recursive: true });
        fs.writeFileSync(
          path.join(outsideRoot, 'skills', 'SKILL.md'),
          '# escaped\n',
        );
      },
      expectedError:
        'Provider directory source must stay within approved roots',
    },
  ])(
    'rejects escaped $name before spawning the container',
    async ({ buildPreparedSession, expectedError, setupOutsideRoot }) => {
      // Arrange
      const groupDir = path.join(groupsDir, 'test-group');
      fs.mkdirSync(groupDir, { recursive: true });

      const providerStateDir = path.join(
        dataDir,
        'sessions',
        'test-group',
        'codex',
      );
      const outsideRoot = path.join(tempRoot, 'outside-root');
      setupOutsideRoot?.(outsideRoot);

      const provider = createPreparedSessionProvider(
        buildPreparedSession(groupDir, providerStateDir, outsideRoot),
      );
      const fakeProc = createFakeProcess();
      const { runContainerAgent, spawnMock } = await loadSubject(
        provider,
        dataDir,
        groupsDir,
        fakeProc,
      );

      // Act
      const run = runContainerAgent(
        createProviderGroup(),
        {
          prompt: 'Ship the provider slice.',
          groupFolder: 'test-group',
          chatJid: 'test@g.us',
          isMain: false,
        },
        () => {},
      );

      // Assert
      await expect(run).rejects.toThrow(expectedError);
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );
});
