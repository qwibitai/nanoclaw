import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runnerEntryPoint = path.join(
  projectRoot,
  'container',
  'agent-runner',
  'src',
  'index.ts',
);

interface RunnerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RuntimeWorkspace {
  root: string;
  globalDir: string;
  groupDir: string;
  extraDir: string;
  ipcDir: string;
  capturePath: string;
  loaderPath: string;
}

const tempRoots: string[] = [];

function createRuntimeWorkspace(): RuntimeWorkspace {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-agent-runner-claude-compat-'),
  );
  tempRoots.push(root);

  const globalDir = path.join(root, 'global');
  const groupDir = path.join(root, 'group');
  const extraDir = path.join(root, 'extra');
  const ipcDir = path.join(root, 'ipc');

  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(extraDir, { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  return {
    root,
    globalDir,
    groupDir,
    extraDir,
    ipcDir,
    capturePath: path.join(root, 'captured-query-options.json'),
    loaderPath: path.join(root, 'mock-claude-sdk-loader.mjs'),
  };
}

function createWorkspaceEnv(
  runtimeWorkspace: RuntimeWorkspace,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NANOCLAW_WORKSPACE_GROUP_DIR: runtimeWorkspace.groupDir,
    NANOCLAW_WORKSPACE_GLOBAL_DIR: runtimeWorkspace.globalDir,
    NANOCLAW_WORKSPACE_EXTRA_DIR: runtimeWorkspace.extraDir,
  };
}

function writeMockSdkLoader(loaderPath: string): void {
  const source = `
import fs from 'node:fs';
import path from 'node:path';

const mockModuleSource = ${JSON.stringify(`
  import fs from 'node:fs';
  import path from 'node:path';

  let callCount = 0;

  function appendCapture(nextCapture) {
    const capturePath = process.env.TEST_CAPTURE_PATH;
    const captures = fs.existsSync(capturePath)
      ? JSON.parse(fs.readFileSync(capturePath, 'utf-8'))
      : [];
    captures.push(nextCapture);
    fs.writeFileSync(capturePath, JSON.stringify(captures));
  }

  export async function* query({ options }) {
    callCount += 1;

    appendCapture({
      callCount,
      resume: options.resume ?? null,
      resumeSessionAt: options.resumeSessionAt ?? null,
      allowedTools: options.allowedTools,
      mcpServers: options.mcpServers,
      settingSources: options.settingSources,
    });

    if (callCount === 1) {
      const ipcInputPath = path.join(
        process.env.NANOCLAW_IPC_DIR,
        'input',
        '0001.json',
      );
      fs.writeFileSync(
        ipcInputPath,
        JSON.stringify({ type: 'message', text: 'Follow up with the team.' }),
      );

      yield { type: 'system', subtype: 'init', session_id: 'session-123' };
      yield { type: 'assistant', uuid: 'assistant-1' };
      yield { type: 'result', subtype: 'success', result: 'first result' };
      return;
    }

    const closeSentinel = path.join(
      process.env.NANOCLAW_IPC_DIR,
      'input',
      '_close',
    );
    fs.writeFileSync(closeSentinel, '');

    yield { type: 'assistant', uuid: 'assistant-2' };
    yield { type: 'result', subtype: 'success', result: 'second result' };
  }
`)};

export async function resolve(specifier, context, defaultResolve) {
  if (specifier === '@anthropic-ai/claude-agent-sdk') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(mockModuleSource),
    };
  }

  return defaultResolve(specifier, context, defaultResolve);
}

export async function load(url, context, defaultLoad) {
  if (url.startsWith('data:text/javascript,')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: decodeURIComponent(url.slice('data:text/javascript,'.length)),
    };
  }

  return defaultLoad(url, context, defaultLoad);
}
`;

  fs.writeFileSync(loaderPath, source);
}

function runRunner(
  args: string[],
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(JSON.stringify(input));
  });
}

describe.sequential('claude-code container provider compatibility', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('preserves resume, resumeSessionAt, MCP wiring, and Claude team tools across follow-up queries', async () => {
    // Arrange
    const runtimeWorkspace = createRuntimeWorkspace();
    writeMockSdkLoader(runtimeWorkspace.loaderPath);
    const env = createWorkspaceEnv(runtimeWorkspace);

    // Act
    const result = await runRunner(
      [
        '--import',
        'tsx',
        '--loader',
        runtimeWorkspace.loaderPath,
        runnerEntryPoint,
      ],
      {
        providerId: 'claude-code',
        runtimeInput: {
          prompt: 'Pick up the existing conversation.',
          sessionId: 'legacy-session',
          groupFolder: 'test-group',
          chatJid: 'test@g.us',
          isMain: false,
        },
      },
      {
        ...env,
        NANOCLAW_IPC_DIR: runtimeWorkspace.ipcDir,
        TEST_CAPTURE_PATH: runtimeWorkspace.capturePath,
      },
    );
    const capturedCalls = JSON.parse(
      fs.readFileSync(runtimeWorkspace.capturePath, 'utf-8'),
    ) as Array<{
      allowedTools: string[];
      callCount: number;
      mcpServers: {
        nanoclaw: {
          args: string[];
          command: string;
          env: Record<string, string>;
        };
      };
      resume: string | null;
      resumeSessionAt: string | null;
      settingSources: string[];
    }>;

    // Assert
    expect(result.code).toBe(0);
    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[0]).toMatchObject({
      callCount: 1,
      resume: 'legacy-session',
      resumeSessionAt: null,
      settingSources: ['project', 'user'],
    });
    expect(capturedCalls[1]).toMatchObject({
      callCount: 2,
      resume: 'session-123',
      resumeSessionAt: 'assistant-1',
    });
    expect(capturedCalls[0].allowedTools).toEqual(
      expect.arrayContaining(['TeamCreate', 'TeamDelete', 'mcp__nanoclaw__*']),
    );
    expect(capturedCalls[0].mcpServers.nanoclaw).toEqual({
      command: 'node',
      args: [expect.stringContaining('ipc-mcp-stdio')],
      env: {
        NANOCLAW_CHAT_JID: 'test@g.us',
        NANOCLAW_GROUP_FOLDER: 'test-group',
        NANOCLAW_IPC_DIR: runtimeWorkspace.ipcDir,
        NANOCLAW_IS_MAIN: '0',
        NANOCLAW_WORKSPACE_ROOT: '/workspace',
      },
    });
  });
});
