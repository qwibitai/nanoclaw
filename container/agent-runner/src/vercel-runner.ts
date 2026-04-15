import fs from 'fs';
import path from 'path';
import { generateText, stepCountIs, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { buildIpcTools } from './tool-bridge.js';
import { loadSession, saveSession } from './session-store.js';
import { buildMcpServerConfigs, connectMcpServers } from './mcp-bridge.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  verbose?: boolean;
  provider?: string;
  model?: string;
  providerBaseUrl?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  numTurns?: number;
  progressLabel?: string;
}

function log(message: string): void {
  console.error(`[vercel-runner] ${message}`);
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function createProviderFactory(provider: string, baseUrl?: string | null) {
  switch (provider) {
    case 'openai':
      return createOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: baseUrl ?? undefined,
      });
    case 'groq':
      return createOpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: baseUrl ?? 'https://api.groq.com/openai/v1',
      });
    case 'together':
      return createOpenAI({
        apiKey: process.env.TOGETHER_AI_API_KEY,
        baseURL: baseUrl ?? 'https://api.together.xyz/v1',
      });
    case 'ollama':
      return createOpenAI({
        apiKey: 'ollama',
        baseURL: baseUrl ?? 'http://host.docker.internal:11434/v1',
      });
    case 'google':
      return createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      });
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

function buildSystemPrompt(input: ContainerInput): string {
  const parts: string[] = [];

  parts.push(
    `You are ${input.assistantName ?? 'an AI assistant'}. You help with tasks by using the available tools.`,
  );

  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    parts.push(fs.readFileSync(groupClaudeMd, 'utf-8'));
  }

  const globalClaudeMd = '/workspace/global/CLAUDE.md';
  if (!input.isMain && fs.existsSync(globalClaudeMd)) {
    parts.push(fs.readFileSync(globalClaudeMd, 'utf-8'));
  }

  const skillsDir = '/workspace/skills';
  if (fs.existsSync(skillsDir)) {
    for (const skill of fs.readdirSync(skillsDir)) {
      const skillMd = path.join(skillsDir, skill, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        parts.push(fs.readFileSync(skillMd, 'utf-8'));
      }
    }
  }

  return parts.join('\n\n---\n\n');
}

function formatToolLabel(toolName: string): string {
  if (toolName === 'send_message') return 'Sending message';
  if (toolName === 'schedule') return 'Scheduling task';
  if (toolName === 'relay_message') return 'Relaying message';
  if (toolName === 'learn_feedback') return 'Recording lesson';
  if (toolName === 'switch_model') return 'Switching model';
  const words = toolName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export async function runVercelQuery(
  prompt: string,
  input: ContainerInput,
): Promise<ContainerOutput> {
  const provider = input.provider ?? 'openai';
  const modelId = input.model ?? 'gpt-4o-mini';

  log(`Provider: ${provider}, Model: ${modelId}`);

  let mcpConnection: Awaited<ReturnType<typeof connectMcpServers>> | undefined;

  try {
    const factory = createProviderFactory(provider, input.providerBaseUrl);
    const model = factory(modelId);

    const ipcTools = buildIpcTools(
      '/workspace/ipc',
      input.chatJid,
      input.groupFolder,
    );

    // Build tools object for Vercel AI SDK. The ipcTools use zod v4 schemas
    // while the AI SDK expects zod v3 schemas in its ToolParameters type.
    // We cast via `any` since the schemas are structurally compatible at runtime
    // and the AI SDK converts them to JSON Schema internally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Record<string, any> = {};
    for (const [name, def] of Object.entries(ipcTools)) {
      tools[name] = {
        description: def.description,
        parameters: def.parameters,
        execute: def.execute,
      };
    }

    // Connect MCP servers for this session
    const mcpConfigs = buildMcpServerConfigs({
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      isMain: input.isMain,
    });
    mcpConnection = await connectMcpServers(mcpConfigs);

    // MCP tools (already in AI SDK format from createMCPClient)
    for (const [name, def] of Object.entries(mcpConnection.tools)) {
      tools[name] = def;
    }

    log(`Tools registered: ${Object.keys(tools).length} (${Object.keys(ipcTools).length} IPC + ${Object.keys(mcpConnection.tools).length} MCP)`);

    const sessionDir = '/workspace/group/sessions/vercel';
    const sessionMessages = loadSession(sessionDir, input.sessionId);

    const messages: ModelMessage[] = [
      ...(sessionMessages as ModelMessage[]),
      { role: 'user' as const, content: prompt },
    ];

    const systemPrompt = buildSystemPrompt(input);

    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      stopWhen: stepCountIs(50),
      onStepFinish: ({ toolCalls }) => {
        for (const tc of toolCalls ?? []) {
          const label = formatToolLabel(tc.toolName);
          writeOutput({
            status: 'success',
            result: null,
            progressLabel: label,
          });
        }
      },
    });

    const allMessages = [...messages, ...result.response.messages];
    const newSessionId = saveSession(
      sessionDir,
      input.sessionId,
      allMessages as unknown as import('./session-store.js').SessionMessage[],
    );

    // Clean up MCP server connections
    await mcpConnection.cleanup();

    return {
      status: 'success',
      result: result.text,
      newSessionId,
      usage: {
        input_tokens: result.usage?.inputTokens,
        output_tokens: result.usage?.outputTokens,
      },
      numTurns: result.steps.length,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Error: ${errorMsg}`);
    try { await mcpConnection?.cleanup(); } catch { /* best-effort */ }
    return {
      status: 'error',
      result: null,
      error: errorMsg,
    };
  }
}
