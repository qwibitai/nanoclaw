/**
 * Codex Provider — Container Module
 *
 * Self-contained Codex API client that runs inside the NanoClaw agent container.
 * Implements a tool-use loop: sends user prompts to the Codex Responses API,
 * executes any requested tool calls (bash, read_file, write_file, list_files),
 * and returns the final text response.
 *
 * This file has NO external npm dependencies — it only uses Node.js built-ins.
 * It is copied into the container at runtime by NanoClaw's container-runner.
 *
 * API Reference:
 *   - Endpoint: https://chatgpt.com/backend-api/codex/responses
 *   - Auth: Bearer token (ChatGPT OAuth access_token)
 *   - Headers: chatgpt-account-id, OpenAI-Beta: responses=experimental
 *   - Body: { model, instructions, input, tools, store: false, stream: true }
 *
 * Based on the protocol used by OpenAI's Codex CLI:
 *   https://github.com/openai/codex
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

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
  secrets?: Record<string, string>;
  provider?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

type CodexInputItem =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

interface CodexOutputItem {
  type: 'message' | 'function_call';
  content?: Array<{ type: string; text?: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface CodexResponse {
  id: string;
  output: CodexOutputItem[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ChatGPT Codex backend endpoint (NOT the OpenAI Platform API) */
const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';

/** Default model — gpt-5.1-codex is the standard Codex model */
const DEFAULT_MODEL = 'gpt-5.1-codex';

/** Maximum tool-use rounds before giving up */
const MAX_TOOL_ROUNDS = 50;

/** Output markers for structured container output */
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/** Environment variables to unset before running user commands (security) */
const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_ACCESS_TOKEN',
  'CODEX_ACCOUNT_ID',
];

// ---------------------------------------------------------------------------
// Tool Definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: 'function' as const,
    name: 'bash',
    description: 'Run a bash command in the workspace. Returns stdout and stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to run',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default 120000)',
        },
      },
      required: ['command'],
    },
  },
  {
    type: 'function' as const,
    name: 'read_file',
    description: 'Read the contents of a file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the file',
        },
      },
      required: ['path'],
    },
  },
  {
    type: 'function' as const,
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path',
        },
        content: {
          type: 'string',
          description: 'Content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    type: 'function' as const,
    name: 'list_files',
    description: 'List files in a directory. Returns one path per line.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path (default: current directory)',
        },
        pattern: {
          type: 'string',
          description: 'Glob pattern to filter (e.g. "*.ts")',
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.error(`[codex-provider] ${message}`);
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

// ---------------------------------------------------------------------------
// Tool Execution
// ---------------------------------------------------------------------------

function executeTool(name: string, argsJson: string): string {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return `Error: Invalid JSON arguments: ${argsJson}`;
  }

  switch (name) {
    case 'bash': {
      const command = args.command as string;
      const timeout = (args.timeout as number) || 120_000;
      // Strip secret env vars before executing user commands
      const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
      try {
        const result = execSync(unsetPrefix + command, {
          timeout,
          cwd: '/workspace/group',
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        });
        return result || '(no output)';
      } catch (err: unknown) {
        const e = err as {
          stdout?: string;
          stderr?: string;
          message?: string;
          status?: number;
        };
        return [
          `Exit code: ${e.status ?? 'unknown'}`,
          e.stdout ? `Stdout: ${e.stdout}` : '',
          `Stderr: ${e.stderr || e.message || ''}`,
        ]
          .filter(Boolean)
          .join('\n');
      }
    }

    case 'read_file': {
      const filePath = args.path as string;
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'write_file': {
      const filePath = args.path as string;
      const content = args.content as string;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        return `File written: ${filePath}`;
      } catch (err) {
        return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'list_files': {
      const dirPath = (args.path as string) || '.';
      const pattern = (args.pattern as string) || '';
      try {
        const cmd = pattern
          ? `find ${dirPath} -type f -name '${pattern}' 2>/dev/null | head -500`
          : `find ${dirPath} -type f 2>/dev/null | head -500`;
        const result = execSync(cmd, {
          cwd: '/workspace/group',
          encoding: 'utf-8',
          timeout: 10_000,
        });
        return result || '(no files found)';
      } catch (err) {
        return `Error listing files: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ---------------------------------------------------------------------------
// SSE Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Server-Sent Events stream from the Codex API.
 * Waits for the `response.done` or `response.completed` event which contains
 * the full response with all output items.
 */
async function parseSSEStream(response: Response): Promise<CodexResponse> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: CodexResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;

      try {
        const event = JSON.parse(data) as {
          type: string;
          response?: CodexResponse;
          error?: { message?: string };
        };
        if (event.type === 'error') {
          throw new Error(event.error?.message || 'Codex API error');
        }
        if (
          event.type === 'response.done' ||
          event.type === 'response.completed'
        ) {
          finalResponse = event.response!;
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes('Codex API error')
        ) {
          throw err;
        }
        // Skip malformed JSON lines
      }
    }
  }

  if (!finalResponse) {
    throw new Error('No response.done event received from Codex API');
  }
  return finalResponse;
}

// ---------------------------------------------------------------------------
// System Prompt Builder
// ---------------------------------------------------------------------------

/**
 * Build the system instructions for the Codex API.
 * Reads CLAUDE.md from the group workspace and adds identity/context info.
 * Sent as the top-level `instructions` field (NOT as a developer role message).
 */
function buildSystemPrompt(input: ContainerInput): string {
  const parts: string[] = [];

  // Group-specific instructions
  const claudeMdPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(claudeMdPath)) {
    parts.push(fs.readFileSync(claudeMdPath, 'utf-8'));
  }

  // Global instructions (for non-main groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (!input.isMain && fs.existsSync(globalClaudeMdPath)) {
    parts.push(fs.readFileSync(globalClaudeMdPath, 'utf-8'));
  }

  parts.push(
    `You are ${input.assistantName || 'Andy'}, a helpful assistant.`,
  );
  parts.push(`Working directory: /workspace/group`);
  parts.push(`Current time: ${new Date().toISOString()}`);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Codex API Call
// ---------------------------------------------------------------------------

/**
 * Call the Codex Responses API.
 *
 * Key differences from the OpenAI Platform API:
 *   - Endpoint: chatgpt.com/backend-api/codex/responses (not api.openai.com)
 *   - Auth: ChatGPT OAuth Bearer token (not API key)
 *   - `store: false` required (stateless, no server-side session)
 *   - `instructions` is a top-level field (not a developer role message)
 *   - `include: ['reasoning.encrypted_content']` for reasoning continuity
 *   - `text.verbosity` controls output verbosity
 */
async function callCodexAPI(
  accessToken: string,
  accountId: string,
  instructions: string,
  input: CodexInputItem[],
): Promise<CodexResponse> {
  const response = await fetch(CODEX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': accountId,
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      instructions,
      store: false,
      stream: true,
      input,
      tools: TOOLS,
      reasoning: { effort: 'medium', summary: 'auto' },
      text: { verbosity: 'medium' },
      include: ['reasoning.encrypted_content'],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Codex API error ${response.status}: ${errorText.slice(0, 500)}`,
    );
  }

  return parseSSEStream(response);
}

// ---------------------------------------------------------------------------
// Extract Text from Response
// ---------------------------------------------------------------------------

function extractText(items: CodexOutputItem[]): string {
  let text = '';
  for (const item of items) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text) {
          text += part.text;
        }
      }
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Run the Codex provider. This is the standard NanoClaw container provider
 * entry point, called by the agent-runner when `provider === 'codex'`.
 *
 * Flow:
 *   1. Build system instructions from CLAUDE.md
 *   2. Send user prompt to Codex API with tool definitions
 *   3. If API returns function_calls → execute tools → send results back
 *   4. Repeat until API returns a text response (no function calls)
 *   5. Output the final text via structured markers
 */
export async function runProvider(
  containerInput: ContainerInput,
): Promise<void> {
  const accessToken = containerInput.secrets?.CODEX_ACCESS_TOKEN;
  const accountId = containerInput.secrets?.CODEX_ACCOUNT_ID;

  if (!accessToken || !accountId) {
    writeOutput({
      status: 'error',
      result: null,
      error:
        'Missing Codex credentials (CODEX_ACCESS_TOKEN or CODEX_ACCOUNT_ID)',
    });
    return;
  }

  // System instructions go as top-level `instructions` field
  const instructions = buildSystemPrompt(containerInput);

  // Conversation history (input items) — starts with just the user message
  const conversation: CodexInputItem[] = [
    { role: 'user', content: containerInput.prompt },
  ];

  let round = 0;

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    log(`Tool-use round ${round}, conversation items: ${conversation.length}`);

    let codexResponse: CodexResponse;
    try {
      codexResponse = await callCodexAPI(
        accessToken,
        accountId,
        instructions,
        conversation,
      );
    } catch (err) {
      writeOutput({
        status: 'error',
        result: null,
        error: `Codex API call failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const functionCalls = codexResponse.output.filter(
      (item) => item.type === 'function_call',
    );
    const messageItems = codexResponse.output.filter(
      (item) => item.type === 'message',
    );

    // No function calls = final text response
    if (functionCalls.length === 0) {
      const text = extractText(messageItems);
      writeOutput({ status: 'success', result: text || null });
      return;
    }

    // Append function_call items to conversation history
    for (const fc of functionCalls) {
      conversation.push({
        type: 'function_call',
        call_id: fc.call_id!,
        name: fc.name!,
        arguments: fc.arguments!,
      });
    }

    // Execute each tool and append results
    for (const fc of functionCalls) {
      log(`Executing tool: ${fc.name} (call_id: ${fc.call_id})`);
      const result = executeTool(fc.name!, fc.arguments!);
      log(
        `Tool result (${result.length} chars): ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`,
      );
      conversation.push({
        type: 'function_call_output',
        call_id: fc.call_id!,
        output: result,
      });
    }

    // Emit any intermediate text as streaming output
    const intermediateText = extractText(messageItems);
    if (intermediateText) {
      writeOutput({ status: 'success', result: intermediateText });
    }
  }

  writeOutput({
    status: 'error',
    result: null,
    error: `Exceeded maximum tool-use rounds (${MAX_TOOL_ROUNDS})`,
  });
}
