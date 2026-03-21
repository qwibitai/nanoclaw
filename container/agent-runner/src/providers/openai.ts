import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

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

interface ResponsesFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

const OPENAI_STATE_DIR = '/home/node/.nanoclaw/openai';
const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_TOOL_LOOPS = 16;
const MAX_TOOL_OUTPUT_CHARS = 120_000;
const execFileAsync = promisify(execFile);
const DEFAULT_WEB_TIMEOUT_MS = 45_000;
const LEGACY_TOOL_REFUSAL_PATTERNS = [
  /does not support NanoClaw tool execution yet/i,
  /tools? are unavailable/i,
];

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

function containsLegacyToolRefusal(text: string): boolean {
  return LEGACY_TOOL_REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
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

  const filteredHistory = history.filter(
    (turn) =>
      turn.role !== 'assistant' || !containsLegacyToolRefusal(turn.content),
  );

  if (filteredHistory.length > 0) {
    sections.push('Conversation so far:');
    for (const turn of filteredHistory) {
      sections.push(
        `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`,
      );
    }
  }

  sections.push('Latest user message:');
  sections.push(prompt);
  sections.push(
    'Respond as the NanoClaw agent. You have working tools. Use shell for local file/command tasks, web_fetch for known URLs, and web_search when you need current web information. Do not claim tools are unavailable.',
  );

  return sections.join('\n\n');
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...<truncated>`;
}

function getToolDefinitions(): unknown[] {
  return [
    {
      type: 'function',
      name: 'shell',
      description:
        'Execute a shell command inside the container workspace. Use this for file inspection, search, edits, git commands, and local operations. This tool can also use curl for direct web requests if needed.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'The shell command to run. Multi-line bash is allowed.',
          },
          working_directory: {
            type: 'string',
            description:
              'Optional working directory. Defaults to /workspace/group.',
          },
          timeout_ms: {
            type: 'integer',
            description:
              'Optional timeout in milliseconds. Defaults to 120000.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'web_fetch',
      description:
        'Fetch a URL from the web and return the response body. Use this for known pages or APIs.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to fetch.',
          },
          timeout_ms: {
            type: 'integer',
            description:
              'Optional timeout in milliseconds. Defaults to 45000.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'web_search',
      description:
        'Search the web for current information and return the result page HTML. Use this when you do not yet know the target URL.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The web search query.',
          },
          timeout_ms: {
            type: 'integer',
            description:
              'Optional timeout in milliseconds. Defaults to 45000.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
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
      const text =
        (chunk as { text?: unknown; type?: unknown }).type === 'output_text'
          ? (chunk as { text?: unknown }).text
          : (chunk as { text?: unknown }).text;
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts.join('\n').trim();
}

function extractFunctionCalls(payload: unknown): ResponsesFunctionCall[] {
  const output = (payload as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(output)) return [];
  return output.filter(
    (item): item is ResponsesFunctionCall =>
      !!item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'function_call' &&
      typeof (item as { call_id?: unknown }).call_id === 'string' &&
      typeof (item as { name?: unknown }).name === 'string' &&
      typeof (item as { arguments?: unknown }).arguments === 'string',
  );
}

function summarizeResponseOutput(payload: unknown): string {
  const output = (payload as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(output) || output.length === 0) return 'none';
  return output
    .map((item) => {
      const type =
        item && typeof item === 'object' && 'type' in item
          ? String((item as { type?: unknown }).type)
          : 'unknown';
      const status =
        item && typeof item === 'object' && 'status' in item
          ? String((item as { status?: unknown }).status)
          : 'n/a';
      return `${type}:${status}`;
    })
    .join(', ');
}

async function runShellTool(
  argsJson: string,
  context: AgentTurnContext,
): Promise<string> {
  let args: {
    command: string;
    working_directory?: string;
    timeout_ms?: number;
  };

  try {
    args = JSON.parse(argsJson) as {
      command: string;
      working_directory?: string;
      timeout_ms?: number;
    };
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: `Invalid shell arguments JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const command = args.command?.trim();
  if (!command) {
    return JSON.stringify({
      ok: false,
      error: 'shell tool requires a non-empty command',
    });
  }

  const cwd = args.working_directory || '/workspace/group';
  const timeout = args.timeout_ms || DEFAULT_SHELL_TIMEOUT_MS;
  context.log(
    `OpenAI shell tool: cwd=${cwd} timeout=${timeout} command=${command.slice(
      0,
      200,
    )}`,
  );

  try {
    const env = Object.fromEntries(
      Object.entries(context.agentEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', command], {
      cwd,
      timeout,
      maxBuffer: MAX_TOOL_OUTPUT_CHARS * 2,
      env,
    });

    return JSON.stringify({
      ok: true,
      exit_code: 0,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
    });
  } catch (err) {
    const error = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return JSON.stringify({
      ok: false,
      exit_code:
        typeof error.code === 'number' ? error.code : String(error.code || ''),
      stdout: truncateOutput(error.stdout || ''),
      stderr: truncateOutput(error.stderr || ''),
      error: error.message || 'shell command failed',
    });
  }
}

async function runWebFetchTool(
  argsJson: string,
  context: AgentTurnContext,
): Promise<string> {
  let args: { url: string; timeout_ms?: number };
  try {
    args = JSON.parse(argsJson) as { url: string; timeout_ms?: number };
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: `Invalid web_fetch arguments JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const url = args.url?.trim();
  if (!url) {
    return JSON.stringify({ ok: false, error: 'web_fetch requires a URL' });
  }

  const curlArgs = [
    '-L',
    '--silent',
    '--show-error',
    '--max-time',
    String(
      Math.ceil((args.timeout_ms || DEFAULT_WEB_TIMEOUT_MS) / 1000),
    ),
  ];
  const env = Object.fromEntries(
    Object.entries(context.agentEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const insecureTls =
    (context.agentEnv.WEB_FETCH_INSECURE_TLS || '').toLowerCase() === 'true';
  const caBundle = context.agentEnv.WEB_FETCH_CA_BUNDLE?.trim();
  if (insecureTls) {
    curlArgs.push('--insecure');
  } else if (caBundle) {
    curlArgs.push('--cacert', caBundle);
  }
  curlArgs.push(url);

  try {
    context.log(
      `OpenAI web_fetch: url=${url} insecure_tls=${insecureTls} ca_bundle=${caBundle || 'default'}`,
    );
    const { stdout, stderr } = await execFileAsync('/usr/bin/curl', curlArgs, {
      cwd: '/workspace/group',
      timeout: args.timeout_ms || DEFAULT_WEB_TIMEOUT_MS,
      maxBuffer: MAX_TOOL_OUTPUT_CHARS * 2,
      env,
    });

    return JSON.stringify({
      ok: true,
      url,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
    });
  } catch (err) {
    const error = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return JSON.stringify({
      ok: false,
      url,
      exit_code:
        typeof error.code === 'number' ? error.code : String(error.code || ''),
      stdout: truncateOutput(error.stdout || ''),
      stderr: truncateOutput(error.stderr || ''),
      error: error.message || 'web_fetch failed',
    });
  }
}

async function runWebSearchTool(
  argsJson: string,
  context: AgentTurnContext,
): Promise<string> {
  let args: { query: string; timeout_ms?: number };
  try {
    args = JSON.parse(argsJson) as { query: string; timeout_ms?: number };
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: `Invalid web_search arguments JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const query = args.query?.trim();
  if (!query) {
    return JSON.stringify({ ok: false, error: 'web_search requires a query' });
  }

  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
  return runWebFetchTool(
    JSON.stringify({
      url: searchUrl,
      timeout_ms: args.timeout_ms || DEFAULT_WEB_TIMEOUT_MS,
    }),
    context,
  );
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

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
  const tools = getToolDefinitions();
  const conversationInput: unknown[] = [
    {
      type: 'message',
      role: 'user',
      content: compiledPrompt,
    },
  ];
  let requestBody: Record<string, unknown> = {
    model,
    input: conversationInput,
    tools,
  };
  let payload: unknown;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI request failed (${response.status}): ${errorBody}`);
    }

    payload = (await response.json()) as unknown;
    context.log(
      `OpenAI response loop=${loop + 1} output=${summarizeResponseOutput(payload)}`,
    );
    const functionCalls = extractFunctionCalls(payload);
    if (functionCalls.length === 0) break;

    context.log(`OpenAI requested ${functionCalls.length} tool call(s)`);
    const toolOutputs: Array<{
      type: 'function_call_output';
      call_id: string;
      output: string;
    }> = [];
    for (const call of functionCalls) {
      let output: string;
      switch (call.name) {
        case 'shell':
          output = await runShellTool(call.arguments, context);
          break;
        case 'web_fetch':
          output = await runWebFetchTool(call.arguments, context);
          break;
        case 'web_search':
          output = await runWebSearchTool(call.arguments, context);
          break;
        default:
          output = JSON.stringify({
            ok: false,
            error: `Unsupported tool: ${call.name}`,
          });
      }

      toolOutputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output,
      });
    }

    conversationInput.push(...functionCalls, ...toolOutputs);

    requestBody = {
      model,
      input: conversationInput,
      tools,
    };
  }

  if (!payload) {
    throw new Error('OpenAI response payload missing');
  }

  const text = extractTextFromResponse(payload);

  state.history.push({ role: 'user', content: context.prompt });
  state.history.push({
    role: 'assistant',
    content: containsLegacyToolRefusal(text)
      ? 'Skipped legacy tool-refusal response.'
      : text,
  });
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
