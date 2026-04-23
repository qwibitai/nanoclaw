/**
 * AgentLite Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  type AgentBackendOptions,
  createQueryRunner,
  drainIpcInput,
  IPC_INPUT_CLOSE_SENTINEL,
  IPC_INPUT_DIR,
  type RuntimeContainerInput,
  takeReadyIpcInput,
  waitForIpcMessage,
} from './agent-backend.js';

interface ContainerInput extends RuntimeContainerInput {
  prompt: string;
  sessionId?: string;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentBackend?: AgentBackendOptions;
}

// ── Container lifecycle events (not SDK) ─────────────────────────

interface ContainerStateOutput {
  type: 'state';
  state: 'active' | 'idle' | 'stopped';
  newSessionId?: string;
  reason?: 'query_started' | 'awaiting_input';
}

interface ContainerResultOutput {
  type: 'result';
  result: string | null;
  newSessionId?: string;
}

interface ContainerErrorOutput {
  type: 'error';
  error: string;
  newSessionId?: string;
}

// ── Raw SDK message passthrough ──────────────────────────────────

/** Every SDK message forwarded as-is. The container is a dumb pipe. */
interface ContainerSdkMessageOutput {
  type: 'sdk_message';
  /** Top-level SDK message type (e.g. 'assistant', 'result', 'system', 'tool_progress', 'stream_event'). */
  sdkType: string;
  /** For system messages: the subtype (e.g. 'init', 'status', 'task_started'). */
  sdkSubtype?: string;
  /** The raw SDK message object, serialized as-is. */
  message: unknown;
}

type ContainerOutput =
  | ContainerStateOutput
  | ContainerResultOutput
  | ContainerErrorOutput
  | ContainerSdkMessageOutput;

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

const OUTPUT_START_MARKER = '---AGENTLITE_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AGENTLITE_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

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
      type: 'error',
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
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
  const pending = drainIpcInput(log);
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  const agentBackend: AgentBackendOptions = containerInput.agentBackend ?? {
    type: 'claudeCode',
  };
  const queryRunner = createQueryRunner(agentBackend, {
    log,
    writeOutput,
  });
  try {
    while (true) {
      log(
        `Starting ${agentBackend.type} query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await queryRunner.run({
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      });
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      const readyInput = takeReadyIpcInput(log);
      if (readyInput === null) {
        log('Close sentinel received after query, exiting');
        break;
      }
      if (readyInput !== undefined) {
        log(
          `Buffered IPC message ready (${readyInput.length} chars), starting new query`,
        );
        prompt = readyInput;
        continue;
      }

      writeOutput({
        type: 'state',
        state: 'idle',
        newSessionId: sessionId,
        reason: 'awaiting_input',
      });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage(log);
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      type: 'error',
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
