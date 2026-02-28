/**
 * ACP (Agent Client Protocol) adapter — makes Sovereign agents driveable
 * from external tools like Zed, Cursor, and other ACP-compatible clients.
 *
 * Bridges ACP sessions to the container-runner pipeline:
 *   ACP prompt → extract text → runContainerAgent() → stream output back
 */

import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  AuthenticateRequest,
  AuthenticateResponse,
} from '@agentclientprotocol/sdk';
import { ChildProcess } from 'child_process';

import {
  ContainerInput,
  ContainerOutput,
  runContainerAgent,
} from './container-runner.js';
import { getAllRegisteredGroups } from './db.js';
import { ASSISTANT_NAME, MAIN_GROUP_FOLDER } from './config.js';
import { RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// ── Pure functions (testable) ───────────────────────────────────────

/**
 * Extract plain text from ACP content blocks.
 * Ignores non-text content (images, audio, resources).
 */
export function extractPromptText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Generate a cryptographically random session ID.
 */
export function generateSessionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── ACP Agent Implementation ────────────────────────────────────────

interface AcpSession {
  id: string;
  group: RegisteredGroup;
  chatJid: string;
  activeProcess: ChildProcess | null;
  pendingPrompt: AbortController | null;
}

export class SovereignAcpAgent implements acp.Agent {
  private connection: acp.AgentSideConnection;
  private sessions = new Map<string, AcpSession>();

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    // No auth required — return empty response
    return {};
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = generateSessionId();

    // Find the main group to bind this session to
    const groups = getAllRegisteredGroups();
    const mainGroup = Object.values(groups).find(
      (g) => g.folder === MAIN_GROUP_FOLDER,
    );

    if (!mainGroup) {
      throw new Error(
        'No main group registered. Start the agent with a channel first.',
      );
    }

    const chatJid = `acp:${sessionId}`;

    this.sessions.set(sessionId, {
      id: sessionId,
      group: mainGroup,
      chatJid,
      activeProcess: null,
      pendingPrompt: null,
    });

    logger.info({ sessionId }, 'ACP session created');

    return { sessionId };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`ACP session ${params.sessionId} not found`);
    }

    // Cancel any existing prompt
    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();

    const text = extractPromptText(params.prompt);
    if (!text.trim()) {
      return { stopReason: 'end_turn' };
    }

    const input: ContainerInput = {
      prompt: text,
      sessionId: session.id,
      groupFolder: session.group.folder,
      chatJid: session.chatJid,
      isMain: true,
      assistantName: ASSISTANT_NAME,
    };

    try {
      const result = await runContainerAgent(
        session.group,
        input,
        (proc) => {
          session.activeProcess = proc;
        },
        async (output: ContainerOutput) => {
          // Stream each output chunk back to the ACP client
          if (output.result) {
            await this.connection.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: output.result,
                },
              },
            });
          }
        },
      );

      session.activeProcess = null;
      session.pendingPrompt = null;

      // Send final result if not already streamed
      if (result.result && result.status === 'success') {
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: result.result,
            },
          },
        });
      }

      if (result.status === 'error') {
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Error: ${result.error || 'Unknown error'}`,
            },
          },
        });
      }

      return { stopReason: 'end_turn' };
    } catch (err) {
      if (session.pendingPrompt?.signal.aborted) {
        return { stopReason: 'cancelled' };
      }
      logger.error({ err, sessionId: params.sessionId }, 'ACP prompt failed');
      throw err;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;

    session.pendingPrompt?.abort();
    if (session.activeProcess) {
      session.activeProcess.kill('SIGTERM');
      session.activeProcess = null;
    }

    logger.info({ sessionId: params.sessionId }, 'ACP session cancelled');
  }
}

// ── Start ACP Server ────────────────────────────────────────────────

export function startAcpServer(): void {
  const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  new acp.AgentSideConnection(
    (conn) => new SovereignAcpAgent(conn),
    stream,
  );

  logger.info('ACP adapter started on stdio');
}
