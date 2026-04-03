/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createContainerProviderRegistry } from './providers/index.js';
import type {
  ContainerAgentProvider,
  ContainerInput,
  ContainerOutput,
  ProviderRuntimeInput,
} from './provider-types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const SCRIPT_TIMEOUT_MS = 30_000;
const DEFAULT_GROUP_WORKSPACE_DIR = '/workspace/group';
const DEFAULT_GLOBAL_WORKSPACE_DIR = '/workspace/global';

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

interface DispatchOptions {
  providers?: Iterable<ContainerAgentProvider>;
  mcpServerPath?: string;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function ensurePathWithinRoots(
  roots: string[],
  candidate: string,
  errorMessage: string,
): string {
  const resolvedPath = path.resolve(candidate);

  for (const root of roots) {
    if (isPathWithinRoot(root, resolvedPath)) {
      return resolvedPath;
    }
  }

  throw new Error(errorMessage);
}

function materializeWorkspaceFiles(
  providerId: string,
  allowedRoots: string[],
  files: Array<{
    sourcePath?: string;
    targetPath: string;
    content?: string;
  }>,
): void {
  for (const file of files) {
    const targetPath = ensurePathWithinRoots(
      allowedRoots,
      file.targetPath,
      `Provider "${providerId}" tried to write outside the mounted workspace`,
    );
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    if (file.content != null) {
      fs.writeFileSync(targetPath, file.content);
      continue;
    }

    if (!file.sourcePath) {
      continue;
    }

    const sourcePath = ensurePathWithinRoots(
      allowedRoots,
      file.sourcePath,
      `Provider "${providerId}" tried to read outside the mounted workspace`,
    );

    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    fs.copyFileSync(sourcePath, targetPath);
  }
}

function defaultMcpServerPath(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, 'ipc-mcp-stdio.js');
}

function groupWorkspaceDir(): string {
  return process.env.NANOCLAW_WORKSPACE_GROUP_DIR || DEFAULT_GROUP_WORKSPACE_DIR;
}

function globalWorkspaceDir(): string {
  return (
    process.env.NANOCLAW_WORKSPACE_GLOBAL_DIR || DEFAULT_GLOBAL_WORKSPACE_DIR
  );
}

export async function* dispatchProviderInput(
  containerInput: ContainerInput,
  options: DispatchOptions = {},
): AsyncGenerator<ContainerOutput> {
  const registry = createContainerProviderRegistry(options.providers);
  const provider = registry.getProvider(containerInput.providerId);
  const workspaceDir = groupWorkspaceDir();
  const globalMemoryDir = containerInput.runtimeInput.isMain
    ? undefined
    : globalWorkspaceDir();
  const preparedWorkspace = await provider.prepareWorkspace({
    providerHomeDir: provider.providerHomeDir,
    workspaceDir,
    globalMemoryDir,
    sessionId: containerInput.runtimeInput.sessionId,
    runtimeInput: containerInput.runtimeInput,
  });

  materializeWorkspaceFiles(
    provider.id,
    [workspaceDir, provider.providerHomeDir, ...(globalMemoryDir ? [globalMemoryDir] : [])],
    preparedWorkspace.files,
  );

  let sessionId = containerInput.runtimeInput.sessionId;
  const abortController = new AbortController();
  const eventStream = await provider.run({
    input: containerInput.runtimeInput,
    abortSignal: abortController.signal,
    mcpServerPath: options.mcpServerPath || defaultMcpServerPath(),
    preparedWorkspace,
  });

  for await (const event of eventStream) {
    switch (event.type) {
      case 'session_started':
        sessionId = event.sessionId;
        break;
      case 'result':
        yield {
          status: 'success',
          result: event.text,
          newSessionId: sessionId,
        };
        break;
      case 'error':
        yield {
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: event.message,
        };
        break;
      case 'warning':
        log(`Provider warning (${provider.id}): ${event.message}`);
        break;
      case 'provider_state':
        log(`Provider state (${provider.id}): ${JSON.stringify(event.state)}`);
        break;
    }
  }
}

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          resolve(null);
          return;
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          resolve(null);
          return;
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            resolve(null);
            return;
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

function prepareRuntimeInput(
  runtimeInput: ProviderRuntimeInput,
  scriptResult: ScriptResult | null,
): ProviderRuntimeInput | null {
  const nextRuntimeInput: ProviderRuntimeInput = {
    ...runtimeInput,
  };

  if (!runtimeInput.script || !runtimeInput.isScheduledTask) {
    return nextRuntimeInput;
  }

  if (!scriptResult || !scriptResult.wakeAgent) {
    const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
    log(`Script decided not to wake agent: ${reason}`);
    return null;
  }

  log('Script wakeAgent=true, enriching prompt with data');
  nextRuntimeInput.prompt =
    `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n` +
    runtimeInput.prompt;
  return nextRuntimeInput;
}

export async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* ignore */
    }
    log(`Received input for provider: ${containerInput.providerId}`);
  } catch (error) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${error instanceof Error ? error.message : String(error)}`,
    });
    process.exit(1);
    return;
  }

  try {
    const scriptResult = await runScriptIfNeeded(containerInput.runtimeInput);
    const preparedRuntimeInput = prepareRuntimeInput(
      containerInput.runtimeInput,
      scriptResult,
    );

    if (!preparedRuntimeInput) {
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    for await (const output of dispatchProviderInput({
      providerId: containerInput.providerId,
      runtimeInput: preparedRuntimeInput,
    })) {
      writeOutput(output);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: containerInput.runtimeInput.sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

async function runScriptIfNeeded(
  runtimeInput: ProviderRuntimeInput,
): Promise<ScriptResult | null> {
  if (!runtimeInput.script || !runtimeInput.isScheduledTask) {
    return null;
  }

  log('Running task script...');
  return runScript(runtimeInput.script);
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedPath === currentFilePath) {
  void main();
}
