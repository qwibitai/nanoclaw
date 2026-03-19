/**
 * E2E test helpers — container lifecycle, MCP protocol, output parsing.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const CONTAINER_IMAGE = 'nanoclaw-agent:latest';
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerOutput {
  status: string;
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: Record<string, unknown>;
}

// Container lifecycle

/**
 * Build the container image. Returns true if build succeeds.
 */
export function buildContainer(): boolean {
  try {
    execSync('./container/build.sh', {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      timeout: 300_000, // 5 min
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a unique container name for test isolation.
 */
export function testContainerName(prefix = 'e2e-test'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Start a container running only the MCP server process.
 * Returns the child process with stdio pipes for MCP communication.
 */
export function startMcpServer(
  containerName: string,
  env: Record<string, string> = {},
): ChildProcess {
  const envArgs = Object.entries({
    NANOCLAW_CHAT_JID: 'e2e:test',
    NANOCLAW_GROUP_FOLDER: 'e2e_test',
    NANOCLAW_IS_MAIN: '1',
    ...env,
  }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  return spawn(
    'docker',
    [
      'run',
      '-i',
      '--rm',
      '--name',
      containerName,
      ...envArgs,
      '--entrypoint',
      'node',
      CONTAINER_IMAGE,
      '/app/dist/ipc-mcp-stdio.js',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

/**
 * Start a full agent container with the given input.
 * ANTHROPIC_BASE_URL points to the stub server on the host.
 */
export function startAgent(
  containerName: string,
  input: Record<string, unknown>,
  stubPort: number,
  options: { tmpDir?: string } = {},
): { process: ChildProcess; tmpDir: string } {
  const tmpDir =
    options.tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));

  // Create required mount directories
  const ipcDir = path.join(tmpDir, 'ipc');
  const messagesDir = path.join(ipcDir, 'messages');
  const inputDir = path.join(ipcDir, 'input');
  const tasksDir = path.join(ipcDir, 'tasks');
  const groupDir = path.join(tmpDir, 'group');
  const claudeDir = path.join(tmpDir, 'claude');
  const globalDir = path.join(tmpDir, 'global');
  const agentRunnerDistDir = path.join(tmpDir, 'agent-runner-dist');

  for (const dir of [
    messagesDir,
    inputDir,
    tasksDir,
    groupDir,
    claudeDir,
    globalDir,
    agentRunnerDistDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Mount pre-compiled agent-runner dist/ if available (no runtime tsc — kaizen #123).
  // If dist/ doesn't exist (e.g., CI hasn't built yet), skip the mount and use the
  // image's built-in dist/ from the Dockerfile.
  const distDir = path.join(PROJECT_ROOT, 'container/agent-runner/dist');
  const hasHostDist =
    fs.existsSync(distDir) && fs.readdirSync(distDir).length > 0;
  if (hasHostDist) {
    fs.cpSync(distDir, agentRunnerDistDir, { recursive: true });
  }

  const hostGateway =
    os.platform() === 'linux'
      ? ['--add-host=host.docker.internal:host-gateway']
      : [];

  const distMount = hasHostDist
    ? ['-v', `${agentRunnerDistDir}:/app/dist`]
    : [];

  const proc = spawn(
    'docker',
    [
      'run',
      '-i',
      '--rm',
      '--name',
      containerName,
      ...hostGateway,
      '-e',
      `ANTHROPIC_BASE_URL=http://host.docker.internal:${stubPort}`,
      '-e',
      'ANTHROPIC_API_KEY=e2e-test-placeholder',
      '-e',
      'NANOCLAW_CHAT_JID=e2e:test',
      '-e',
      'NANOCLAW_GROUP_FOLDER=e2e_test',
      '-e',
      'NANOCLAW_IS_MAIN=1',
      '-e',
      `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      '-v',
      `${groupDir}:/workspace/group`,
      '-v',
      `${ipcDir}:/workspace/ipc`,
      '-v',
      `${claudeDir}:/home/node/.claude`,
      '-v',
      `${globalDir}:/workspace/global:ro`,
      ...distMount,
      CONTAINER_IMAGE,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();

  return { process: proc, tmpDir };
}

/**
 * Force-remove a container by name (ignores errors if already stopped).
 */
export function cleanupContainer(name: string): void {
  try {
    execSync(`docker rm -f ${name}`, { stdio: 'pipe', timeout: 10_000 });
  } catch {
    // Container may already be gone
  }
}

/**
 * Clean up a temp directory (ignores errors).
 */
export function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

// Output parsing

/**
 * Collect all stdout data from a child process until it exits.
 * Returns the full stdout string and exit code.
 */
export function collectOutput(
  proc: ChildProcess,
  timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGKILL');
        resolve({ stdout, stderr, exitCode: null });
      }
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      }
    });
  });
}

/**
 * Parse output markers from container stdout.
 * Returns an array of parsed ContainerOutput objects.
 */
export function parseOutputMarkers(stdout: string): ContainerOutput[] {
  const results: ContainerOutput[] = [];
  let remaining = stdout;

  while (true) {
    const startIdx = remaining.indexOf(OUTPUT_START_MARKER);
    if (startIdx === -1) break;

    const afterStart = remaining.slice(startIdx + OUTPUT_START_MARKER.length);
    const endIdx = afterStart.indexOf(OUTPUT_END_MARKER);
    if (endIdx === -1) break;

    const jsonStr = afterStart.slice(0, endIdx).trim();
    try {
      results.push(JSON.parse(jsonStr));
    } catch {
      // Skip malformed output
    }

    remaining = afterStart.slice(endIdx + OUTPUT_END_MARKER.length);
  }

  return results;
}

// MCP protocol helpers

/**
 * Send a JSON-RPC request to an MCP server via stdin and read the response.
 */
export async function sendMcpRequest(
  proc: ChildProcess,
  method: string,
  params: Record<string, unknown> = {},
  id: number = 1,
): Promise<Record<string, unknown>> {
  const request = {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };

  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      reject(new Error(`MCP request ${method} timed out after 30s`));
    }, 30_000);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      // MCP stdio uses newline-delimited JSON
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            clearTimeout(timeout);
            proc.stdout?.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch {
          // Not complete JSON yet, keep buffering
        }
      }
      // Keep last incomplete line in buffer
      buffer = lines[lines.length - 1];
    };

    proc.stdout?.on('data', onData);
    proc.stdin?.write(JSON.stringify(request) + '\n');
  });
}

/**
 * Initialize an MCP server and list its tools.
 * Returns the tool names.
 */
export async function getMcpTools(proc: ChildProcess): Promise<string[]> {
  await sendMcpRequest(
    proc,
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0.0' },
    },
    1,
  );

  // Send initialized notification (no response expected)
  proc.stdin?.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n',
  );

  const response = await sendMcpRequest(proc, 'tools/list', {}, 2);
  const result = response.result as { tools?: Array<{ name: string }> };
  return (result?.tools ?? []).map((t) => t.name);
}
