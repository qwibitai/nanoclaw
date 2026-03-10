/**
 * Cursor ACP Agent Runner
 * Receives ContainerInput via stdin, runs `agent acp` as a persistent daemon,
 * and outputs ContainerOutput via stdout using the IPC marker protocol.
 * Uses @agentclientprotocol/sdk ClientSideConnection (JSON-RPC 2.0 over stdio).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable, Writable } from 'stream';
import { fileURLToPath } from 'url';

import * as acp from '@agentclientprotocol/sdk';

import {
  ContainerInput,
  applyScheduledTaskPrefix,
  drainIpcInput,
  loadSystemContext,
  readStdin,
  waitForIpcMessage,
  writeOutput,
} from './shared.js';

const IPC_INPUT_DIR = path.join(process.env.NANOCLAW_IPC_DIR ?? '', 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');

function log(message: string): void {
  console.error(`[cursor-runner] ${message}`);
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function buildPrompt(containerInput: ContainerInput, promptText: string): string {
  const ctx = loadSystemContext(containerInput);
  const systemPrefix = [
    ctx.identityContent,
    ctx.globalClaudeMd,
    ctx.bootstrapContent,
    ctx.toolsContent,
  ]
    .filter(Boolean)
    .join('\n\n');

  const text = applyScheduledTaskPrefix(promptText, containerInput.isScheduledTask);
  return systemPrefix ? `${systemPrefix}\n\n---\n\n${text}` : text;
}

function buildMcpServers(
  mcpServerPath: string,
  containerInput: ContainerInput,
): acp.McpServerStdio[] {
  return [
    {
      name: 'nanoclaw',
      command: 'node',
      args: [mcpServerPath],
      env: [
        { name: 'NANOCLAW_IPC_DIR', value: process.env.NANOCLAW_IPC_DIR ?? '' },
        { name: 'NANOCLAW_CHAT_JID', value: containerInput.chatJid },
        { name: 'NANOCLAW_GROUP_FOLDER', value: containerInput.groupFolder },
        { name: 'NANOCLAW_IS_MAIN', value: containerInput.isMain ? '1' : '0' },
      ],
    },
  ];
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
  const mcpServers = buildMcpServers(mcpServerPath, containerInput);

  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    ...(containerInput.secrets ?? {}),
  };

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  const pending = drainIpcInput(IPC_INPUT_DIR);
  let initialPromptText = containerInput.prompt;
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    initialPromptText += '\n' + pending.join('\n');
  }

  log('Spawning agent acp');
  const agentProc = spawn('agent', ['acp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv as NodeJS.ProcessEnv,
  });

  agentProc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log(`stderr: ${text}`);
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(agentProc.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(agentProc.stdout!) as ReadableStream<Uint8Array>,
  );

  let sessionId = containerInput.sessionId;
  let textBuffer = '';

  const client: acp.Client = {
    async sessionUpdate(params) {
      const update = params.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        textBuffer += update.content.text;
      }
    },
    async requestPermission(params) {
      const allowOnce =
        params.options.find((o: acp.PermissionOption) => o.kind === 'allow_once') ??
        params.options[0];
      return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } };
    },
  };

  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  try {
    await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION });

    if (sessionId) {
      try {
        log(`Loading session: ${sessionId}`);
        await connection.loadSession({ sessionId, cwd: groupDir, mcpServers });
      } catch (loadErr) {
        log(`Session load failed (${serializeError(loadErr)}), creating new session`);
        sessionId = undefined;
        const r = await connection.newSession({ cwd: groupDir, mcpServers });
        sessionId = r.sessionId;
        log(`New session created: ${sessionId}`);
      }
    } else {
      log('Creating new session');
      const r = await connection.newSession({ cwd: groupDir, mcpServers });
      sessionId = r.sessionId;
      log(`New session created: ${sessionId}`);
    }

    let currentPromptText = initialPromptText;
    let isFirstPrompt = true;

    while (true) {
      const prompt = isFirstPrompt
        ? buildPrompt(containerInput, currentPromptText)
        : currentPromptText;
      isFirstPrompt = false;
      log(`Sending prompt (session: ${sessionId}, chars: ${prompt.length})`);

      textBuffer = '';
      await connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });

      if (textBuffer) {
        writeOutput({ status: 'success', result: textBuffer, newSessionId: sessionId });
        textBuffer = '';
      }
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Prompt complete, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage(IPC_INPUT_DIR, IPC_INPUT_CLOSE_SENTINEL);
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars)`);
      currentPromptText = nextMessage;
    }
  } catch (err) {
    const errorMessage = serializeError(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: errorMessage });
    process.exit(1);
  } finally {
    agentProc.kill();
  }
}
