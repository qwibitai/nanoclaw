/**
 * Generic OpenAI-compatible agent runner.
 * Used when AGENT_PROVIDER is 'openrouter' with non-Claude models, or 'openai'.
 *
 * Implements a tool-calling loop using the OpenAI chat completions API format,
 * which is supported by OpenRouter, Ollama, Grok, Groq, Together, and others.
 *
 * Supports a minimal but functional tool set: Bash, ReadFile, WriteFile.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import OpenAI from 'openai';

const execFileAsync = promisify(execFile);

export interface GenericRunnerConfig {
  /** OpenAI-compatible base URL (from ANTHROPIC_BASE_URL or provider default) */
  baseUrl: string;
  /** Bearer token or API key */
  apiKey: string;
  /** Model identifier e.g. "meta-llama/llama-3.1-70b" or "llama3.1" */
  model: string;
  /** Working directory for Bash commands */
  cwd: string;
  /** Chat JID — passed to log context */
  chatJid: string;
  /** Assistant name for system prompt */
  assistantName?: string;
}

export interface GenericRunnerResult {
  text: string | null;
}

const TOOL_BASH = 'bash';
const TOOL_READ_FILE = 'read_file';
const TOOL_WRITE_FILE = 'write_file';
const BASH_TIMEOUT_MS = 30_000;
const MAX_BASH_OUTPUT = 8_000;
const MAX_ITERATIONS = 20;

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: TOOL_BASH,
      description:
        'Execute a bash command in the workspace. Use for searching, running scripts, or any shell operations.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_READ_FILE,
      description: 'Read the contents of a file.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute or workspace-relative file path',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_WRITE_FILE,
      description: 'Write content to a file (creates or overwrites).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute or workspace-relative file path',
          },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

function buildSystemPrompt(assistantName?: string): string {
  const name = assistantName || 'LearnClaw';
  return `You are ${name}, an AI learning assistant running inside a secure container.

Your primary purpose is to help users with structured learning — particularly exam preparation (UPSC, competitive exams), language learning, and study planning.

You have access to a workspace at /workspace/group containing the user's notes, progress, and learning materials.

When helping users:
- Be concise and focused on learning goals
- Reference their actual study materials when available
- Track progress and adapt to their level
- Keep responses conversational and encouraging

You have access to tools for reading/writing files and running bash commands in the workspace. Use them to access the user's learning materials and update their progress.

Current working directory: /workspace/group`;
}

async function executeTool(
  name: string,
  args: Record<string, string>,
  cwd: string,
): Promise<string> {
  if (name === TOOL_BASH) {
    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-c', args.command], {
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: MAX_BASH_OUTPUT * 2,
        cwd,
        env: { ...process.env, HOME: '/workspace/group' },
      });
      let output = stdout;
      if (stderr) output += '\nSTDERR:\n' + stderr;
      if (output.length > MAX_BASH_OUTPUT) {
        output = output.slice(0, MAX_BASH_OUTPUT) + '\n[output truncated]';
      }
      return output || '(no output)';
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const out = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
      return `Error: ${out.slice(0, 2000)}`;
    }
  }

  if (name === TOOL_READ_FILE) {
    const filePath = path.isAbsolute(args.path)
      ? args.path
      : path.join(cwd, args.path);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.length > MAX_BASH_OUTPUT) {
        return content.slice(0, MAX_BASH_OUTPUT) + '\n[file truncated]';
      }
      return content;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === TOOL_WRITE_FILE) {
    const filePath = path.isAbsolute(args.path)
      ? args.path
      : path.join(cwd, args.path);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content, 'utf-8');
      return `Written ${args.content.length} bytes to ${filePath}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return `Unknown tool: ${name}`;
}

export async function runGenericAgent(
  prompt: string,
  config: GenericRunnerConfig,
): Promise<GenericRunnerResult> {
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(config.assistantName) },
    { role: 'user', content: prompt },
  ];

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await client.chat.completions.create({
      model: config.model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    });

    const choice = response.choices[0];
    if (!choice) break;

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    if (choice.finish_reason === 'stop' || !assistantMessage.tool_calls?.length) {
      // Final response
      return { text: assistantMessage.content || null };
    }

    // Process tool calls
    const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];
    for (const toolCall of assistantMessage.tool_calls) {
      let args: Record<string, string> = {};
      try {
        const fn = toolCall.type === 'function' ? toolCall.function : null;
        if (fn) args = JSON.parse(fn.arguments);
      } catch {
        args = {};
      }
      const fn = toolCall.type === 'function' ? toolCall.function : null;
      const result = fn
        ? await executeTool(fn.name, args, config.cwd)
        : 'Unsupported tool type';
      toolResults.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    messages.push(...toolResults);
  }

  // Max iterations hit — return last text content if any
  let lastText: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0) {
      lastText = m.content;
      break;
    }
  }
  return { text: lastText };
}
