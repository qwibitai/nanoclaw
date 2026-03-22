/**
 * NanoClaw Agent Runner (CLI Mode)
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * Spawns `claude -p` CLI with `--input-format stream-json` instead of using
 * the Agent SDK query(). All host protocols are preserved:
 *   - stdin: Full ContainerInput JSON (read until EOF)
 *   - stdout: OUTPUT_START/END marker-wrapped JSON
 *   - IPC: File-based polling in /workspace/ipc/input/
 *   - MCP: ipc-mcp-stdio.ts subprocess (unchanged, via --mcp-config)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// ---- Host protocol (unchanged from upstream) ----

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

// ---- IPC file polling (unchanged from upstream) ----

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(
      `IPC drain error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// ---- CLI integration (new) ----

/** Write a user message to the CLI's stdin as stream-json NDJSON. */
function writeUserMessage(stdin: NodeJS.WritableStream, text: string): void {
  const msg = {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
  stdin.write(JSON.stringify(msg) + '\n');
}

function buildCliArgs(input: ContainerInput): string[] {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Write MCP config (reuses existing ipc-mcp-stdio.ts as stdio subprocess)
  const mcpConfig = {
    mcpServers: {
      nanoclaw: {
        type: 'stdio',
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: input.chatJid,
          NANOCLAW_GROUP_FOLDER: input.groupFolder,
          NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
        },
      },
    },
  };
  fs.writeFileSync(
    '/tmp/nanoclaw-mcp-config.json',
    JSON.stringify(mcpConfig),
  );

  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--strict-mcp-config',
    '--mcp-config',
    '/tmp/nanoclaw-mcp-config.json',
    '--setting-sources',
    'project,user',
    '--allowed-tools',
    'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,' +
      'Task,TaskOutput,TaskStop,TeamCreate,TeamDelete,SendMessage,' +
      'TodoWrite,ToolSearch,Skill,NotebookEdit,mcp__nanoclaw__*',
  ];

  // Model override (CLI defaults to Sonnet if not specified)
  if (process.env.CLAUDE_MODEL) {
    args.push('--model', process.env.CLAUDE_MODEL);
  }

  // Global CLAUDE.md as additional system context (non-main only, matching upstream)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (!input.isMain && fs.existsSync(globalClaudeMdPath)) {
    args.push('--append-system-prompt-file', globalClaudeMdPath);
  }

  // Additional directories mounted at /workspace/extra/*
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        args.push('--add-dir', fullPath);
      }
    }
  }

  // Resume existing session
  if (input.sessionId) {
    args.push('--resume', input.sessionId);
  }

  return args;
}

/** Inject CLI hook config into settings.json before spawning CLI. */
function injectHooksIntoSettings(): void {
  const settingsPath = path.join(
    process.env.HOME || '/home/node',
    '.claude',
    'settings.json',
  );
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      /* ignore parse errors */
    }
  }
  settings.hooks = {
    PreCompact: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node /tmp/dist/hooks/pre-compact.js',
          },
        ],
      },
    ],
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ---- Main ----

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Write assistant name for hook script to read
  fs.writeFileSync(
    '/workspace/group/.assistant-name',
    containerInput.assistantName || '',
  );

  // Inject hooks into settings before CLI spawn
  injectHooksIntoSettings();

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Spawn CLI
  const cliArgs = buildCliArgs(containerInput);
  log('Spawning CLI');

  const cli = spawn('claude', cliArgs, {
    cwd: '/workspace/group',
    env: { ...process.env, CLAUDECODE: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  cli.on('error', (err) => {
    log(`CLI spawn error: ${err.message}`);
    writeOutput({
      status: 'error',
      result: null,
      error: `CLI spawn error: ${err.message}`,
    });
    process.exit(1);
  });

  cli.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log(`[cli] ${line}`);
    }
  });

  // Send initial message
  writeUserMessage(cli.stdin!, prompt);

  // --- State ---
  let sessionId = containerInput.sessionId;
  let closeRequested = false;
  let resultReceived = false;

  // --- IPC file polling (concurrent with CLI event reading) ---
  let ipcPolling = true;
  const pollIpc = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected');
      closeRequested = true;
      // CRITICAL: Only end stdin after result to prevent killing session
      if (resultReceived) {
        cli.stdin!.end();
      }
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into CLI (${text.length} chars)`);
      writeUserMessage(cli.stdin!, text);
      resultReceived = false;
    }
    setTimeout(pollIpc, IPC_POLL_MS);
  };
  setTimeout(pollIpc, IPC_POLL_MS);

  // --- Read NDJSON events from CLI stdout ---
  const rl = readline.createInterface({ input: cli.stdout! });

  try {
    for await (const line of rl) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // Skip non-JSON lines
      }

      const eventType =
        event.type === 'system'
          ? `system/${event.subtype}`
          : String(event.type);
      log(`[event] ${eventType}`);

      // Capture session ID from init event
      if (event.type === 'system' && event.subtype === 'init') {
        sessionId = event.session_id as string;
        log(`Session initialized: ${sessionId}`);
      }

      if (event.type === 'system' && event.subtype === 'task_notification') {
        log(
          `Task notification: task=${event.task_id} status=${event.status} summary=${event.summary}`,
        );
      }

      // Result — send to host via stdout markers (same format as upstream)
      if (event.type === 'result') {
        resultReceived = true;
        const textResult = (event.result as string) || null;
        log(`Result: ${textResult ? textResult.slice(0, 200) : '(none)'}`);
        writeOutput({
          status: 'success',
          result: textResult,
          newSessionId: sessionId,
        });

        // Close guard: only end stdin after result
        if (closeRequested) {
          log('Close was requested, ending CLI stdin');
          cli.stdin!.end();
          break;
        }

        // Session update between turns (same as upstream)
        writeOutput({
          status: 'success',
          result: null,
          newSessionId: sessionId,
        });
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }

  // Wait for CLI to exit
  const exitCode = await new Promise<number | null>((resolve) =>
    cli.on('close', resolve),
  );
  log(`CLI exited with code ${exitCode}`);

  ipcPolling = false;
}

main();
