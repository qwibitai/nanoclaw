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

const tempRoots: string[] = [];

function createRuntimeWorkspace() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-agent-runner-memory-'),
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

function writeMockSdkLoader(
  loaderPath: string,
  compatibilityPath: string,
): void {
  const source = `
import fs from 'node:fs';
import path from 'node:path';

const mockModuleSource = ${JSON.stringify(`
  import fs from 'node:fs';
  import path from 'node:path';

  export async function* query({ options }) {
    fs.writeFileSync(
      process.env.TEST_CAPTURE_PATH,
      JSON.stringify({
        systemPrompt: options.systemPrompt ?? null,
        cwd: options.cwd,
        mcpEnv: options.mcpServers?.nanoclaw?.env ?? null,
      }),
    );
    fs.writeFileSync(${JSON.stringify(compatibilityPath)}, '# Provider Compatibility Edit\\n');
    const closeSentinel = path.join(process.env.NANOCLAW_IPC_DIR, 'input', '_close');
    fs.mkdirSync(path.dirname(closeSentinel), { recursive: true });
    yield { type: 'system', subtype: 'init', session_id: 'session-123' };
    yield { type: 'result', subtype: 'success', result: 'ok' };
    fs.writeFileSync(closeSentinel, '');
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

describe.sequential('container agent runner global memory', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('uses canonical global AGENT.md for non-main runs and never syncs compatibility edits back', async () => {
    // Arrange
    const runtimeWorkspace = createRuntimeWorkspace();
    const canonicalPath = path.join(runtimeWorkspace.globalDir, 'AGENT.md');
    const compatibilityPath = path.join(
      runtimeWorkspace.globalDir,
      'CLAUDE.md',
    );
    fs.writeFileSync(canonicalPath, '# Canonical Global\n');
    fs.writeFileSync(compatibilityPath, '# Legacy Compatibility\n');
    writeMockSdkLoader(runtimeWorkspace.loaderPath, compatibilityPath);

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
          prompt: 'Use the shared context.',
          groupFolder: 'test-group',
          chatJid: 'test@g.us',
          isMain: false,
        },
      },
      {
        ...process.env,
        NANOCLAW_IPC_DIR: runtimeWorkspace.ipcDir,
        NANOCLAW_WORKSPACE_ROOT: runtimeWorkspace.root,
        TEST_CAPTURE_PATH: runtimeWorkspace.capturePath,
      },
    );
    const capturedQuery = JSON.parse(
      fs.readFileSync(runtimeWorkspace.capturePath, 'utf-8'),
    ) as {
      cwd: string;
      mcpEnv: Record<string, string> | null;
      systemPrompt: { append: string; preset: string; type: string } | null;
    };

    // Assert
    expect(result.code).toBe(0);
    expect(capturedQuery.cwd).toBe(runtimeWorkspace.groupDir);
    expect(capturedQuery.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: '# Canonical Global\n',
    });
    expect(capturedQuery.mcpEnv).toMatchObject({
      NANOCLAW_IPC_DIR: runtimeWorkspace.ipcDir,
      NANOCLAW_WORKSPACE_ROOT: runtimeWorkspace.root,
    });
    expect(fs.readFileSync(canonicalPath, 'utf-8')).toBe(
      '# Canonical Global\n',
    );
    expect(fs.readFileSync(compatibilityPath, 'utf-8')).toBe(
      '# Provider Compatibility Edit\n',
    );
  });
});
