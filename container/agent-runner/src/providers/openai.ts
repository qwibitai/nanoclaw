import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  AgentProvider,
  AgentTurnContext,
  AgentTurnResult,
} from '../types.js';

interface OpenAIHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface OpenAISessionState {
  history: OpenAIHistoryTurn[];
}

const OPENAI_STATE_DIR = '/home/node/.nanoclaw/openai';
const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';

function ensureStateDir(): void {
  fs.mkdirSync(OPENAI_STATE_DIR, { recursive: true });
}

function getStateFile(sessionId: string): string {
  return path.join(OPENAI_STATE_DIR, `${sessionId}.json`);
}

function loadSessionState(sessionId: string): OpenAISessionState {
  ensureStateDir();
  const filePath = getStateFile(sessionId);
  if (!fs.existsSync(filePath)) return { history: [] };

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as OpenAISessionState;
  } catch {
    return { history: [] };
  }
}

function saveSessionState(sessionId: string, state: OpenAISessionState): void {
  ensureStateDir();
  fs.writeFileSync(getStateFile(sessionId), `${JSON.stringify(state, null, 2)}\n`);
}

function loadGlobalContext(isMain: boolean): string {
  if (isMain) return '';

  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (!fs.existsSync(globalClaudeMdPath)) return '';

  return fs.readFileSync(globalClaudeMdPath, 'utf-8').trim();
}

function loadAdditionalDirectoriesSummary(): string {
  const extraBase = '/workspace/extra';
  if (!fs.existsSync(extraBase)) return '';

  const dirs = fs
    .readdirSync(extraBase)
    .map((entry) => path.join(extraBase, entry))
    .filter((fullPath) => fs.statSync(fullPath).isDirectory());

  if (dirs.length === 0) return '';
  return `Additional mounted directories are available at:\n${dirs
    .map((dir) => `- ${dir}`)
    .join('\n')}`;
}

function buildPrompt(
  history: OpenAIHistoryTurn[],
  prompt: string,
  context: AgentTurnContext,
): string {
  const sections: string[] = [];

  const globalContext = loadGlobalContext(context.containerInput.isMain);
  if (globalContext) {
    sections.push('Global instructions:');
    sections.push(globalContext);
  }

  const extraDirsSummary = loadAdditionalDirectoriesSummary();
  if (extraDirsSummary) sections.push(extraDirsSummary);

  if (history.length > 0) {
    sections.push('Conversation so far:');
    for (const turn of history) {
      sections.push(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`);
    }
  }

  sections.push('Latest user message:');
  sections.push(prompt);
  sections.push(
    'Respond as the agent. Plain text only. If a tool or MCP capability is required, explain that this backend does not support NanoClaw tool execution yet.',
  );

  return sections.join('\n\n');
}

function extractTextFromResponse(payload: unknown): string {
  if (
    payload &&
    typeof payload === 'object' &&
    'output_text' in payload &&
    typeof (payload as { output_text?: unknown }).output_text === 'string'
  ) {
    return (payload as { output_text: string }).output_text;
  }

  const output = (payload as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(output)) return '';

  const texts: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    for (const chunk of content) {
      const text = (chunk as { text?: unknown }).text;
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts.join('\n').trim();
}

async function runOpenAITurn(
  context: AgentTurnContext,
): Promise<AgentTurnResult> {
  const sessionId = context.sessionId || crypto.randomUUID();
  const state = loadSessionState(sessionId);
  const model = context.agentEnv.AGENT_MODEL || DEFAULT_OPENAI_MODEL;
  const baseUrl = (context.agentEnv.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
    /\/$/,
    '',
  );
  const apiKey = context.agentEnv.OPENAI_API_KEY || '';
  const compiledPrompt = buildPrompt(state.history, context.prompt, context);

  context.log(
    `Running OpenAI turn (session: ${sessionId}, model: ${model}, history: ${state.history.length})`,
  );

  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: compiledPrompt,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorBody}`);
  }

  const payload = (await response.json()) as unknown;
  const text = extractTextFromResponse(payload);

  state.history.push({ role: 'user', content: context.prompt });
  state.history.push({ role: 'assistant', content: text });
  saveSessionState(sessionId, state);

  context.emitOutput({
    status: 'success',
    result: text || null,
    newSessionId: sessionId,
  });

  return {
    newSessionId: sessionId,
    closedDuringQuery: false,
  };
}

export const openaiProvider: AgentProvider = {
  name: 'openai',
  runTurn: runOpenAITurn,
};
