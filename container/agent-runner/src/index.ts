import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { OpencodeClient } from '@opencode-ai/sdk';

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

interface IpcMessage {
  type: 'message';
  text: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
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

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {}
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
        const data = JSON.parse(
          fs.readFileSync(filePath, 'utf-8'),
        ) as IpcMessage;
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
        } catch {}
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
      if (shouldClose()) {
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

function extractResponseText(parts: unknown[]): string {
  const textParts: string[] = [];
  for (const part of parts) {
    if (part && typeof part === 'object' && 'type' in part) {
      const typedPart = part as { type: string; text?: string };
      if (typedPart.type === 'text' && typedPart.text) {
        textParts.push(typedPart.text);
      }
    }
  }
  return textParts.join('');
}

async function waitForAssistantResponse(
  client: OpencodeClient,
  sessionId: string,
  timeoutMs: number = 300000,
): Promise<{ text: string; success: boolean }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const messagesResponse = await client.session.messages({
        path: { id: sessionId },
      });

      if (messagesResponse.error) {
        log(
          `Error getting messages: ${JSON.stringify(messagesResponse.error)}`,
        );
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const messages = messagesResponse.data;
      if (!messages || messages.length === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const assistantMessages = messages.filter(
        (m: unknown) =>
          m &&
          typeof m === 'object' &&
          'role' in m &&
          (m as { role: string }).role === 'assistant',
      );

      if (assistantMessages.length > 0) {
        const lastMessage = assistantMessages[assistantMessages.length - 1] as {
          parts?: unknown[];
        };
        if (lastMessage.parts && lastMessage.parts.length > 0) {
          const text = extractResponseText(lastMessage.parts);
          if (text) return { text, success: true };
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      log(
        `Error polling for messages: ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return { text: '', success: false };
}

async function createOpencodeServer(
  directory: string,
): Promise<{ url: string; close(): void }> {
  const hostname = '127.0.0.1';
  const port = 4096;
  const timeout = 10000;

  const config = {
    provider: {
      'openai-compatible': {
        name: 'LM Studio',
        api: 'http://host.docker.internal:1234/v1',
      },
    },
    model: `openai-compatible/${process.env.NANOCLAW_LLM_MODEL_ID || 'default'}`,
  };

  const args = ['serve', `--hostname=${hostname}`, `--port=${port}`];
  const proc = spawn('opencode', args, {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
    cwd: directory,
  });

  const url = await new Promise<string>((resolve, reject) => {
    const id = setTimeout(() => {
      proc.kill();
      reject(
        new Error(`Timeout waiting for server to start after ${timeout}ms`),
      );
    }, timeout);

    let output = '';
    proc.stdout?.on('data', (chunk) => {
      output += chunk.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('listening')) {
          const match = line.match(/(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve(match[1]!);
            return;
          }
        }
      }
    });

    proc.stderr?.on('data', (chunk) => {
      output += chunk.toString();
      log(`Server stderr: ${chunk.toString().trim()}`);
    });

    proc.on('exit', (code) => {
      clearTimeout(id);
      reject(new Error(`Server exited with code ${code}. Output: ${output}`));
    });

    proc.on('error', (error) => {
      clearTimeout(id);
      reject(error);
    });
  });

  log(`OpenCode server started at ${url}`);
  return { url, close: () => proc.kill() };
}

async function runQuery(
  client: OpencodeClient,
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
): Promise<{ newSessionId: string; closedDuringQuery: boolean }> {
  let currentSessionId: string;
  let closedDuringQuery = false;

  if (sessionId) {
    currentSessionId = sessionId;
    log(`Using existing session: ${currentSessionId}`);
  } else {
    log('Creating new session...');
    const createResponse = await client.session.create({
      body: { title: `NanoClaw-${containerInput.groupFolder}` },
    });

    if (createResponse.error) {
      throw new Error(
        `Failed to create session: ${JSON.stringify(createResponse.error)}`,
      );
    }

    const session = createResponse.data as { id: string };
    currentSessionId = session.id;
    log(`Created new session: ${currentSessionId}`);
  }

  let ipcPolling = true;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query');
      closedDuringQuery = true;
      ipcPolling = false;
      return;
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  try {
    const modelId = process.env.NANOCLAW_LLM_MODEL_ID || 'default';

    log(`Sending prompt to session ${currentSessionId}...`);
    const promptResponse = await client.session.prompt({
      path: { id: currentSessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        model: { providerID: 'openai-compatible', modelID: modelId },
      },
    });

    if (promptResponse.error) {
      throw new Error(
        `Failed to send prompt: ${JSON.stringify(promptResponse.error)}`,
      );
    }

    log('Waiting for assistant response...');
    const { text, success } = await waitForAssistantResponse(
      client,
      currentSessionId,
    );

    if (!success) {
      throw new Error('Timeout waiting for assistant response');
    }

    log(`Got response (${text.length} chars)`);

    writeOutput({
      status: 'success',
      result: text,
      newSessionId: currentSessionId,
    });
  } finally {
    ipcPolling = false;
  }

  return { newSessionId: currentSessionId, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData) as ContainerInput;
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  let server: { url: string; close(): void } | null = null;
  let client: OpencodeClient | null = null;

  try {
    log('Starting OpenCode server...');
    server = await createOpencodeServer('/workspace/group');
    client = createOpencodeClient({ baseUrl: server.url });

    const lmStudioUrl = 'http://host.docker.internal:1234/v1';
    const modelId = process.env.NANOCLAW_LLM_MODEL_ID || 'default';
    log(`Using LM Studio at ${lmStudioUrl}, model: ${modelId}`);

    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {}

    let prompt = containerInput.prompt;
    if (containerInput.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }
    const pending = drainIpcInput();
    if (pending.length > 0) {
      log(
        `Draining ${pending.length} pending IPC messages into initial prompt`,
      );
      prompt += '\n' + pending.join('\n');
    }

    let sessionId = containerInput.sessionId;

    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      if (!client) {
        throw new Error('Client not initialized');
      }

      const queryResult = await runQuery(
        client,
        prompt,
        sessionId,
        containerInput,
      );
      sessionId = queryResult.newSessionId;

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Failed to initialize OpenCode: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: `OpenCode initialization failed: ${errorMessage}`,
    });
    process.exit(1);
  } finally {
    if (server) {
      log('Shutting down OpenCode server...');
      server.close();
    }
  }
}

main();
