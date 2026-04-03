/**
 * GitHub Copilot SDK query adapter for NanoClaw
 *
 * Provides a query interface compatible with the agent-runner's main loop,
 * using the GitHub Copilot SDK instead of the Anthropic Claude Agent SDK.
 *
 * The Copilot SDK supports MCP servers, tools, session resumption, and streaming,
 * enabling feature parity with the Claude integration.
 */

import {
  CopilotClient,
  approveAll,
  type SessionEvent,
  type SessionConfig,
  type MCPServerConfig,
} from '@github/copilot-sdk';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface CopilotQueryResult {
  newSessionId?: string;
  closedDuringQuery: boolean;
}

type WriteOutputFn = (output: ContainerOutput) => void;
type LogFn = (message: string) => void;
type ShouldCloseFn = () => boolean;
type DrainIpcFn = () => string[];

// ---------------------------------------------------------------------------
// Copilot client singleton (reused across queries within one container run)
// ---------------------------------------------------------------------------

let copilotClient: CopilotClient | null = null;

function getCopilotClient(): CopilotClient {
  if (!copilotClient) {
    copilotClient = new CopilotClient({
      autoStart: true,
      logLevel: 'error',
    });
  }
  return copilotClient;
}

export async function stopCopilotClient(): Promise<void> {
  if (copilotClient) {
    try {
      await copilotClient.stop();
    } catch {
      // ignore stop errors
    }
    copilotClient = null;
  }
}

// ---------------------------------------------------------------------------
// Query implementation
// ---------------------------------------------------------------------------

export async function runCopilotQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  _sdkEnv: Record<string, string | undefined>,
  writeOutput: WriteOutputFn,
  log: LogFn,
  shouldClose: ShouldCloseFn,
  drainIpcInput: DrainIpcFn,
  ipcPollMs: number,
): Promise<CopilotQueryResult> {
  const client = getCopilotClient();

  // Log authentication method
  if (process.env.GITHUB_TOKEN) {
    log('Copilot auth: using GITHUB_TOKEN env var');
  } else if (fs.existsSync('/home/node/.copilot')) {
    log('Copilot auth: using OAuth credentials from ~/.copilot/');
  } else {
    log('Warning: No Copilot authentication found (set GITHUB_TOKEN or run copilot auth login)');
  }

  // Build MCP server config matching what Claude gets
  const mcpServers: Record<string, MCPServerConfig> = {
    nanoclaw: {
      type: 'local',
      tools: ['*'],
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    },
  };

  // Load global CLAUDE.md as system context
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let systemMessage: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    systemMessage = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Build session config
  const model = process.env.COPILOT_MODEL || 'gpt-4.1';
  const sessionConfig: SessionConfig = {
    model,
    streaming: true,
    workingDirectory: '/workspace/group',
    mcpServers,
    onPermissionRequest: approveAll,
    ...(systemMessage ? { systemMessage: { content: systemMessage } } : {}),
  };

  log(`Creating Copilot session (model: ${model}, resume: ${sessionId || 'new'})`);

  // Create or resume session
  const session = sessionId
    ? await client.resumeSession(sessionId, { model, onPermissionRequest: approveAll })
    : await client.createSession(sessionConfig);

  const newSessionId = session.sessionId;
  log(`Copilot session ready: ${newSessionId}`);

  // Track IPC polling and close sentinel
  let ipcPolling = true;
  let closedDuringQuery = false;

  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during Copilot query');
      closedDuringQuery = true;
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into Copilot session (${text.length} chars)`);
      session.send({ prompt: text }).catch((err: Error) => {
        log(`Failed to pipe IPC message: ${err.message}`);
      });
    }
    setTimeout(pollIpcDuringQuery, ipcPollMs);
  };
  setTimeout(pollIpcDuringQuery, ipcPollMs);

  // Send prompt and collect response via events
  return new Promise<CopilotQueryResult>((resolve, reject) => {
    let resultEmitted = false;

    session.on((event: SessionEvent) => {
      if (event.type === 'assistant.message') {
        const content = event.data.content || '';
        if (content) {
          log(`Copilot result (${content.length} chars): ${content.slice(0, 200)}`);
          writeOutput({
            status: 'success',
            result: content,
            newSessionId,
          });
          resultEmitted = true;
        }
      } else if (event.type === 'assistant.message_delta') {
        // Streaming delta — logged but not emitted as separate output.
        // The final assistant.message contains the full content.
      } else if (event.type === 'session.idle') {
        ipcPolling = false;

        if (!resultEmitted) {
          // Session completed without emitting a result (e.g. tool-only turn)
          writeOutput({
            status: 'success',
            result: null,
            newSessionId,
          });
        }

        resolve({ newSessionId, closedDuringQuery });
      } else if (event.type === 'session.error') {
        ipcPolling = false;
        const errorMsg = event.data.message || 'Copilot session error';
        log(`Copilot error: ${errorMsg}`);
        writeOutput({
          status: 'error',
          result: null,
          newSessionId,
          error: errorMsg,
        });
        resolve({ newSessionId, closedDuringQuery });
      }
    });

    session.send({ prompt }).catch((err: Error) => {
      ipcPolling = false;
      reject(err);
    });
  });
}
