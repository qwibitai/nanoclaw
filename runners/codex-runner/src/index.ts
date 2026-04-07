import fs from 'fs';
import path from 'path';

import {
  CodexAppServerClient,
  type AppServerInputItem,
} from './app-server-client.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentType?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  phase?: 'progress' | 'final';
  newSessionId?: string;
  error?: string;
}

const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || process.cwd();
const IPC_DIR = process.env.NANOCLAW_IPC_DIR || path.join(process.cwd(), 'ipc');
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.4';
const CODEX_EFFORT = process.env.CODEX_EFFORT || 'high';

let closeRequested = false;

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[codex-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function consumeCloseSentinel(): boolean {
  if (closeRequested) return true;
  if (!fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) return false;

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
  closeRequested = true;
  return true;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
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
          `Failed to process input file ${file}: ${
            err instanceof Error ? err.message : String(err)
          }`,
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
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (consumeCloseSentinel()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function extractImagePaths(text: string): {
  cleanText: string;
  imagePaths: string[];
} {
  const imagePattern = /\[Image:\s*(\/[^\]]+)\]/g;
  const imagePaths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = imagePattern.exec(text)) !== null) {
    imagePaths.push(match[1].trim());
  }

  return {
    cleanText: text.replace(imagePattern, '').trim(),
    imagePaths,
  };
}

function parseAppServerInput(text: string): AppServerInputItem[] {
  const { cleanText, imagePaths } = extractImagePaths(text);
  const input: AppServerInputItem[] = [];

  if (cleanText) {
    input.push({ type: 'text', text: cleanText, text_elements: [] });
  }

  for (const imgPath of imagePaths) {
    if (fs.existsSync(imgPath)) {
      input.push({ type: 'localImage', path: imgPath });
      log(`Adding image input: ${imgPath}`);
    } else {
      log(`Image not found, skipping: ${imgPath}`);
    }
  }

  if (input.length === 0) {
    input.push({ type: 'text', text, text_elements: [] });
  }

  return input;
}

function loadBaseInstructions(): string | undefined {
  const agentSystemMdPath = path.join(GROUP_DIR, 'SYSTEM-codex.md');
  const sharedSystemMdPath = path.join(GROUP_DIR, 'SYSTEM.md');
  const systemMdPath = fs.existsSync(agentSystemMdPath)
    ? agentSystemMdPath
    : fs.existsSync(sharedSystemMdPath)
      ? sharedSystemMdPath
      : null;

  if (!systemMdPath) return undefined;
  return fs.readFileSync(systemMdPath, 'utf-8').trim();
}

async function ensureThread(
  client: CodexAppServerClient,
  sessionId: string | undefined,
  baseInstructions: string | undefined,
): Promise<string> {
  const normalizedSessionId =
    sessionId && sessionId !== 'active' ? sessionId : undefined;

  try {
    return await client.startOrResumeThread(normalizedSessionId, {
      cwd: GROUP_DIR,
      model: CODEX_MODEL || undefined,
      baseInstructions,
    });
  } catch (err) {
    if (!normalizedSessionId) {
      throw err;
    }
    log(
      `Failed to resume thread ${normalizedSessionId}, starting a new thread: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return client.startOrResumeThread(undefined, {
      cwd: GROUP_DIR,
      model: CODEX_MODEL || undefined,
      baseInstructions,
    });
  }
}

async function executeAppServerTurn(
  client: CodexAppServerClient,
  threadId: string,
  prompt: string,
): Promise<{ result: string | null; interrupted: boolean }> {
  let interrupted = false;
  const activeTurn = await client.startTurn(threadId, parseAppServerInput(prompt), {
    cwd: GROUP_DIR,
    model: CODEX_MODEL || undefined,
    effort: CODEX_EFFORT || undefined,
  });

  let polling = true;
  const pollDuringTurn = async (): Promise<void> => {
    if (!polling) return;

    if (consumeCloseSentinel()) {
      interrupted = true;
      polling = false;
      try {
        await activeTurn.interrupt();
      } catch (err) {
        log(
          `Interrupt failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    const messages = drainIpcInput();
    for (const message of messages) {
      try {
        await activeTurn.steer(parseAppServerInput(message));
      } catch (err) {
        log(
          `Steer failed, message dropped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    setTimeout(() => {
      void pollDuringTurn();
    }, IPC_POLL_MS);
  };

  setTimeout(() => {
    void pollDuringTurn();
  }, IPC_POLL_MS);

  try {
    const result = await activeTurn.wait();
    return {
      result: result.result,
      interrupted,
    };
  } catch (err) {
    if (interrupted) {
      return { result: null, interrupted: true };
    }
    throw err;
  } finally {
    polling = false;
  }
}

async function main(): Promise<void> {
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
    return;
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  const currentPath = process.env.PATH || '';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: currentPath.includes('/opt/homebrew/bin')
      ? currentPath
      : `/opt/homebrew/bin:${currentPath || '/usr/local/bin:/usr/bin:/bin'}`,
  };
  const client = new CodexAppServerClient({
    cwd: GROUP_DIR,
    env,
    log,
  });

  let sessionId = containerInput.sessionId;
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += `\n${pending.join('\n')}`;
  }

  try {
    await client.start();
    const threadId = await ensureThread(
      client,
      sessionId,
      loadBaseInstructions(),
    );
    sessionId = threadId;

    while (true) {
      const turn = await executeAppServerTurn(client, threadId, prompt);
      writeOutput({
        status: 'success',
        result: turn.result,
        newSessionId: threadId,
      });

      if (turn.interrupted) {
        log('Close requested during active turn, exiting');
        break;
      }

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close requested while idle, exiting');
        break;
      }

      prompt = nextMessage;
    }
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

void main();
