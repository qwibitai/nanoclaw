/**
 * Ollama Agent Runner for NanoClaw.
 * Provides an agentic loop using Ollama's /api/chat endpoint with tool calling.
 * Uses the same unified session format as the Claude runner for cross-provider switching.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ContainerInput,
  writeOutput,
  log,
  drainIpcInput,
  waitForIpcMessage,
  shouldClose,
  preparePrompt,
  IPC_INPUT_DIR,
  IPC_INPUT_CLOSE_SENTINEL,
} from './index.js';
import {
  UnifiedSession,
  createSession,
  loadSession,
  appendMessage,
  saveSession,
  getMessagesForOllama,
} from './unified-session.js';
import { TOOL_DEFINITIONS, OllamaToolDef, executeTool } from './tools.js';

const MAX_TOOL_ROUNDS = 25;

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

interface OllamaToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  message: OllamaChatMessage;
  done: boolean;
  model: string;
  eval_count?: number;
  prompt_eval_count?: number;
}

/**
 * Connect to the NanoClaw MCP server for IPC tools (send_message, schedule_task, etc.)
 */
async function connectMcpTools(
  containerInput: ContainerInput,
): Promise<{ client: Client; tools: OllamaToolDef[] } | null> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  try {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [mcpServerPath],
      env: {
        ...process.env,
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    });
    const client = new Client({ name: 'ollama-runner', version: '1.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const ollamaTools: OllamaToolDef[] = tools.map((t) => ({
      type: 'function',
      function: {
        name: `mcp_nanoclaw_${t.name}`,
        description: t.description || '',
        parameters: (t.inputSchema as OllamaToolDef['function']['parameters']) || {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    }));

    log(`MCP tools connected: ${ollamaTools.map((t) => t.function.name).join(', ')}`);
    return { client, tools: ollamaTools };
  } catch (err) {
    log(
      `Failed to connect MCP tools: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function loadSystemPrompt(isMain: boolean): string {
  const parts: string[] = [];

  const groupMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupMd)) {
    parts.push(fs.readFileSync(groupMd, 'utf-8'));
  }

  if (!isMain) {
    const globalMd = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalMd)) {
      parts.push(fs.readFileSync(globalMd, 'utf-8'));
    }
  }

  parts.push(
    'You have access to tools for file operations, shell commands, and messaging. ' +
      'Use them when needed to accomplish tasks. Think step by step and use tools iteratively.',
  );

  return parts.join('\n\n');
}

async function callOllama(
  ollamaHost: string,
  model: string,
  messages: OllamaChatMessage[],
  tools: OllamaToolDef[],
): Promise<OllamaChatResponse> {
  const url = `${ollamaHost}/api/chat`;
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };
  if (tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama API error ${response.status}: ${text}`);
  }

  return (await response.json()) as OllamaChatResponse;
}

/**
 * Execute a single tool call, routing to either built-in tools or MCP.
 */
async function executeToolCall(
  toolCall: OllamaToolCall,
  mcpClient: Client | null,
): Promise<string> {
  const name = toolCall.function.name;
  const args = toolCall.function.arguments;

  // Route MCP tools to the MCP client
  if (name.startsWith('mcp_nanoclaw_') && mcpClient) {
    const mcpToolName = name.replace('mcp_nanoclaw_', '');
    log(`Calling MCP tool: ${mcpToolName}`);
    try {
      const result = await mcpClient.callTool({
        name: mcpToolName,
        arguments: args,
      });
      const contentArr = Array.isArray(result.content) ? result.content : [];
      const text = contentArr
        .map((c: { type: string; text?: string }) =>
          c.type === 'text' ? c.text : '',
        )
        .join('');
      return text || '(no output)';
    } catch (err) {
      return `MCP tool error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Built-in tools
  return executeTool(name, args);
}

/**
 * Run the agentic loop for a single user turn.
 * Calls Ollama, executes tools, feeds results back, repeats until text-only response.
 */
async function runAgenticLoop(
  ollamaHost: string,
  model: string,
  session: UnifiedSession,
  allTools: OllamaToolDef[],
  mcpClient: Client | null,
): Promise<string> {
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    const messages = getMessagesForOllama(session) as OllamaChatMessage[];

    log(`Ollama call #${rounds} (${messages.length} messages, model: ${model})`);
    const response = await callOllama(ollamaHost, model, messages, allTools);
    const assistantMsg = response.message;

    // Check for tool calls
    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      // Append assistant message with tool calls to session
      appendMessage(session, {
        role: 'assistant',
        content: assistantMsg.content || '',
        toolCalls: assistantMsg.tool_calls.map((tc) => ({
          id: tc.id || `call-${rounds}-${Math.random().toString(36).slice(2, 8)}`,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
        provider: 'ollama',
        model,
      });

      // Execute each tool call and append results
      for (const tc of assistantMsg.tool_calls) {
        const toolId =
          tc.id || `call-${rounds}-${Math.random().toString(36).slice(2, 8)}`;
        log(
          `Tool call: ${tc.function.name}(${JSON.stringify(tc.function.arguments).slice(0, 200)})`,
        );
        const result = await executeToolCall(
          { ...tc, id: toolId },
          mcpClient,
        );
        log(`Tool result (${result.length} chars): ${result.slice(0, 200)}`);

        appendMessage(session, {
          role: 'tool',
          content: result,
          toolCallId: toolId,
          provider: 'ollama',
          model,
        });
      }

      continue;
    }

    // No tool calls — this is the final text response
    const text = assistantMsg.content || '';
    appendMessage(session, {
      role: 'assistant',
      content: text,
      provider: 'ollama',
      model,
    });

    return text;
  }

  // Safety cap reached
  const msg =
    'Reached maximum tool call rounds. Here is what I have so far based on the tools I used.';
  appendMessage(session, {
    role: 'assistant',
    content: msg,
    provider: 'ollama',
    model,
  });
  return msg;
}

export async function runOllamaAgent(
  containerInput: ContainerInput,
): Promise<void> {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
  const model = containerInput.ollamaModel || 'llama3.2';

  log(`Ollama agent starting (model: ${model}, host: ${ollamaHost})`);

  // Verify Ollama is reachable
  try {
    const healthResp = await fetch(`${ollamaHost}/api/tags`);
    if (!healthResp.ok) throw new Error(`status ${healthResp.status}`);
    log('Ollama is reachable');
  } catch (err) {
    const msg = `Cannot reach Ollama at ${ollamaHost}: ${err instanceof Error ? err.message : String(err)}. Is Ollama running?`;
    log(msg);
    writeOutput({ status: 'error', result: null, error: msg });
    return;
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  // Clean up stale _close sentinel
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  const { prompt: initialPrompt, shouldRun } =
    await preparePrompt(containerInput);
  if (!shouldRun) return;

  // Load or create unified session
  const session =
    (containerInput.unifiedSessionId
      ? loadSession(containerInput.unifiedSessionId)
      : null) || createSession('ollama');
  session.lastProvider = 'ollama';

  // Add system prompt as first message if session is new
  if (session.messages.length === 0) {
    const systemPrompt = loadSystemPrompt(containerInput.isMain);
    appendMessage(session, {
      role: 'system',
      content: systemPrompt,
      provider: 'ollama',
      model,
    });
  }

  // Connect MCP tools
  const mcp = await connectMcpTools(containerInput);
  const allTools = [...TOOL_DEFINITIONS, ...(mcp?.tools || [])];
  log(`Available tools: ${allTools.map((t) => t.function.name).join(', ')}`);

  let prompt = initialPrompt;

  try {
    while (true) {
      log(`Starting Ollama query (session: ${session.id})...`);

      // Add user message to session
      appendMessage(session, {
        role: 'user',
        content: prompt,
        provider: 'ollama',
        model,
      });

      // Run the agentic loop
      const result = await runAgenticLoop(
        ollamaHost,
        model,
        session,
        allTools,
        mcp?.client || null,
      );

      // Save session and emit output
      saveSession(session);
      writeOutput({
        status: 'success',
        result,
        newSessionId: session.id,
      });

      // Check if close was requested during tool execution
      if (shouldClose()) {
        log('Close sentinel detected after query, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Ollama agent error: ${errorMessage}`);
    saveSession(session);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: session.id,
      error: errorMessage,
    });
    process.exit(1);
  } finally {
    // Clean up MCP client
    try {
      await mcp?.client.close();
    } catch {
      /* ignore */
    }
  }
}
