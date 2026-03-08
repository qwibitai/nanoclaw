/**
 * Cursor CLI Agent Runner
 * Receives ContainerInput via stdin, runs Cursor CLI headless, outputs ContainerOutput via stdout.
 * Reuses ipc-mcp-stdio.js as MCP server so the Cursor agent has the same send_message/create_task tools.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ContainerInput,
  readStdin,
  writeOutput,
  drainIpcInput,
  waitForIpcMessage,
  shouldClose,
  loadSystemContext,
  applyScheduledTaskPrefix,
} from './shared.js';

const IPC_INPUT_DIR = path.join(process.env.NANOCLAW_IPC_DIR ?? '', 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const REAL_HOME = os.userInfo().homedir;
const GLOBAL_MCP_PATH = path.join(REAL_HOME, '.cursor', 'mcp.json');

function log(message: string): void {
  console.error(`[cursor-runner] ${message}`);
}

let previousMcpContent: string | null = null;

function writeConfigs(groupDir: string, mcpServerPath: string, containerInput: ContainerInput): void {
  const cursorDir = path.join(groupDir, '.cursor');
  fs.mkdirSync(cursorDir, { recursive: true });

  const globalCursorDir = path.join(REAL_HOME, '.cursor');
  fs.mkdirSync(globalCursorDir, { recursive: true });

  if (fs.existsSync(GLOBAL_MCP_PATH)) {
    previousMcpContent = fs.readFileSync(GLOBAL_MCP_PATH, 'utf-8');
  }

  const mcpConfig = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_IPC_DIR: process.env.NANOCLAW_IPC_DIR ?? '',
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    },
  };

  fs.writeFileSync(GLOBAL_MCP_PATH, JSON.stringify(mcpConfig, null, 2));

  const ctx = loadSystemContext(containerInput);
  const sandboxConfig = {
    additionalReadwritePaths: ctx.extraDirs,
  };
  fs.writeFileSync(
    path.join(cursorDir, 'sandbox.json'),
    JSON.stringify(sandboxConfig, null, 2),
  );
}

function cleanupConfigs(): void {
  try {
    if (previousMcpContent !== null) {
      fs.writeFileSync(GLOBAL_MCP_PATH, previousMcpContent);
    } else {
      fs.unlinkSync(GLOBAL_MCP_PATH);
    }
  } catch { /* ignore */ }
}

process.on('exit', cleanupConfigs);
process.on('SIGTERM', () => { cleanupConfigs(); process.exit(0); });
process.on('SIGINT', () => { cleanupConfigs(); process.exit(0); });

function buildPrompt(containerInput: ContainerInput, promptText: string): string {
  const ctx = loadSystemContext(containerInput);
  const systemPrefix = [
    ctx.identityContent,
    ctx.globalClaudeMd,
    ctx.bootstrapContent,
    ctx.toolsContent,
  ].filter(Boolean).join('\n\n');

  const text = applyScheduledTaskPrefix(promptText, containerInput.isScheduledTask);
  return systemPrefix ? `${systemPrefix}\n\n---\n\n${text}` : text;
}

interface SpawnResult {
  newSessionId?: string;
  fatalError?: boolean;
}

async function spawnAgent(
  prompt: string,
  sessionId: string | undefined,
  groupDir: string,
  spawnEnv: Record<string, string | undefined>,
): Promise<SpawnResult> {
  const args = [
    prompt,
    '--print',
    '--output-format', 'stream-json',
    '--force',
    '--trust',
    '--approve-mcps',
    '--workspace', groupDir,
  ];

  if (sessionId) {
    args.unshift('--resume', sessionId);
  }

  log(`Spawning agent with workspace=${groupDir}, resume=${sessionId ?? 'none'}`);

  return new Promise<SpawnResult>((resolve, reject) => {
    const proc = spawn('agent', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv as NodeJS.ProcessEnv,
    });

    let newSessionId: string | undefined;
    let lineBuffer = '';
    let messageCount = 0;
    let resultCount = 0;
    let hadOutput = false;
    let hadAssistantOutput = false;
    let stderrBuffer = '';
    let lastEventHint = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          handleEvent(event);
        } catch { /* non-JSON line, ignore */ }
      }
    });

    function handleEvent(event: Record<string, unknown>): void {
      const type = event.type as string;
      messageCount++;
      log(`[msg #${messageCount}] type=${type}`);

      if (type === 'system' && event.subtype === 'init') {
        newSessionId = event.session_id as string;
        log(`Session initialized: ${newSessionId}`);
        return;
      }

      if (type === 'assistant') {
        const message = event.message as { content?: Array<{ type: string; text?: string }> };
        const text = message?.content
          ?.filter(c => c.type === 'text')
          .map(c => c.text ?? '')
          .join('') ?? '';
        if (text) {
          hadOutput = true;
          hadAssistantOutput = true;
          writeOutput({ status: 'success', result: text, newSessionId });
        }
        return;
      }

      if (type === 'result') {
        resultCount++;
        hadOutput = true;
        const isError = event.is_error as boolean;
        log(`Result #${resultCount}: isError=${isError}`);
        if (isError) {
          const errText = (event.result as string | undefined) || lastEventHint || stderrBuffer || 'Cursor agent returned an error';
          writeOutput({ status: 'error', result: null, error: errText, newSessionId });
        } else if (!hadAssistantOutput) {
          // No streaming chunks yet — send the full result text
          writeOutput({ status: 'success', result: (event.result as string | null) ?? null, newSessionId });
        } else {
          // Already streamed via type=assistant — just signal completion
          writeOutput({ status: 'success', result: null, newSessionId });
        }
        return;
      }

      // For unhandled event types, try to extract any text that might describe an error
      try {
        const raw = JSON.stringify(event);
        if (raw.length < 500) lastEventHint = `[${type}] ${raw}`;
      } catch { /* ignore */ }
    }

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      stderrBuffer += (stderrBuffer ? '\n' : '') + text;
      log(`stderr: ${text}`);
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      if (lineBuffer.trim()) {
        try {
          handleEvent(JSON.parse(lineBuffer.trim()));
        } catch { /* ignore */ }
      }
      log(`agent process exited with code ${code}`);
      let fatalError = false;
      if (!hadOutput && code !== 0) {
        const errMsg = stderrBuffer || lastEventHint || `Cursor agent exited with code ${code}`;
        log(`No output produced, reporting error: ${errMsg}`);
        writeOutput({ status: 'error', result: null, error: errMsg, newSessionId });
        fatalError = true;
      }
      resolve({ newSessionId, fatalError });
    });
  });
}

export async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const groupDir = process.env.NANOCLAW_GROUP_DIR ?? containerInput.groupFolder;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    ...(containerInput.secrets ?? {}),
  };

  writeConfigs(groupDir, mcpServerPath, containerInput);

  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  const pending = drainIpcInput(IPC_INPUT_DIR);
  let initialPromptText = containerInput.prompt;
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    initialPromptText += '\n' + pending.join('\n');
  }

  let sessionId = containerInput.sessionId;
  let currentPromptText = initialPromptText;

  try {
    while (true) {
      log(`Starting query (session: ${sessionId ?? 'new'})...`);
      const prompt = buildPrompt(containerInput, currentPromptText);
      const result = await spawnAgent(prompt, sessionId, groupDir, spawnEnv);
      if (result.newSessionId) {
        sessionId = result.newSessionId;
      }

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage(IPC_INPUT_DIR, IPC_INPUT_CLOSE_SENTINEL);
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      currentPromptText = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: errorMessage });
    process.exit(1);
  } finally {
    cleanupConfigs();
  }
}
