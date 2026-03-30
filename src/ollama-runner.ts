/**
 * Ollama Runner for NanoClaw
 * Replaces the Docker/Claude container runner with a direct Ollama API call.
 * Maintains multi-turn conversation history per group session.
 * Loads CLAUDE.md files as the system prompt.
 */
import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ConversationSession {
  sessionId: string;
  messages: OllamaMessage[];
  createdAt: string;
  updatedAt: string;
}

function sessionFilePath(groupFolder: string): string {
  const dir = path.join(DATA_DIR, 'sessions', groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ollama-session.json');
}

function loadSession(
  groupFolder: string,
  sessionId?: string,
): ConversationSession {
  const filePath = sessionFilePath(groupFolder);
  if (sessionId && fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(
        fs.readFileSync(filePath, 'utf-8'),
      ) as ConversationSession;
      if (data.sessionId === sessionId) {
        return data;
      }
    } catch {
      // Corrupted session — start fresh
    }
  }
  const newId = `${groupFolder}-${Date.now()}`;
  return {
    sessionId: newId,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function saveSession(groupFolder: string, session: ConversationSession): void {
  const filePath = sessionFilePath(groupFolder);
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
}

/**
 * Build system prompt from CLAUDE.md files.
 * Loads: global CLAUDE.md → group CLAUDE.md (more specific wins).
 */
function buildSystemPrompt(groupFolder: string, assistantName: string): string {
  const parts: string[] = [
    `You are ${assistantName}, a helpful personal assistant. Be concise and direct.`,
    `Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`,
  ];

  const globalClaude = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  if (fs.existsSync(globalClaude)) {
    parts.push(fs.readFileSync(globalClaude, 'utf-8').trim());
  }

  const groupDir = resolveGroupFolderPath(groupFolder);
  const groupClaude = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(groupClaude)) {
    parts.push(fs.readFileSync(groupClaude, 'utf-8').trim());
  }

  return parts.join('\n\n');
}

async function callOllama(messages: OllamaMessage[]): Promise<string> {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    message?: { content?: string };
    error?: string;
  };
  if (data.error) throw new Error(data.error);
  return data.message?.content ?? '';
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  _onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  try {
    // Check Ollama is reachable
    const health = await fetch(`${OLLAMA_URL}/api/tags`).catch(() => null);
    if (!health?.ok) {
      return {
        status: 'error',
        result: null,
        error: 'Ollama is not reachable at ' + OLLAMA_URL,
      };
    }

    const assistantName = input.assistantName || 'Andy';
    const systemPrompt = buildSystemPrompt(input.groupFolder, assistantName);

    // Load or create session
    const session = loadSession(input.groupFolder, input.sessionId);

    // Prepend system message if session is fresh
    const messages: OllamaMessage[] =
      session.messages.length === 0
        ? [{ role: 'system', content: systemPrompt }]
        : session.messages;

    // Add new user message
    messages.push({ role: 'user', content: input.prompt });

    logger.info(
      {
        group: group.name,
        model: OLLAMA_MODEL,
        sessionId: session.sessionId,
        turns: messages.length,
      },
      'Calling Ollama',
    );

    const reply = await callOllama(messages);

    // Store assistant reply in history
    messages.push({ role: 'assistant', content: reply });
    session.messages = messages;
    saveSession(input.groupFolder, session);

    const duration = Date.now() - startTime;
    logger.info(
      { group: group.name, duration, replyLength: reply.length },
      'Ollama response received',
    );

    const output: ContainerOutput = {
      status: 'success',
      result: reply,
      newSessionId: session.sessionId,
    };

    if (onOutput) {
      await onOutput(output);
      return {
        status: 'success',
        result: null,
        newSessionId: session.sessionId,
      };
    }

    return output;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, error }, 'Ollama agent error');
    return { status: 'error', result: null, error };
  }
}

/**
 * Stub: no containers to snapshot for Ollama mode.
 */
export function writeTasksSnapshot(
  _groupFolder: string,
  _isMain: boolean,
  _tasks: unknown[],
): void {}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Stub: no containers to snapshot for Ollama mode.
 */
export function writeGroupsSnapshot(
  _groupFolder: string,
  _isMain: boolean,
  _groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {}

/**
 * Verify Ollama is running. Throws if not reachable.
 */
export function ensureOllamaRunning(): void {
  // Async check done at first agent call — nothing to do synchronously.
  logger.info(
    { url: OLLAMA_URL, model: OLLAMA_MODEL },
    'Ollama runner configured',
  );
}
