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
  extractUserText,
  estimateTokens,
  findCompactionSplitPoint,
  applyCompaction,
} from './unified-session.js';
import { TOOL_DEFINITIONS, OllamaToolDef, executeTool } from './tools.js';

const MAX_TOOL_ROUNDS = 25;

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
  images?: string[]; // base64-encoded images for vision models
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

function loadSystemPrompt(_isMain: boolean): string {
  const parts: string[] = [];

  // Load group-specific CLAUDE.md
  const groupMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupMd)) {
    parts.push(fs.readFileSync(groupMd, 'utf-8'));
  }

  // Always load global CLAUDE.md for Ollama (unlike Claude SDK which handles
  // it internally, Ollama needs it explicitly in the system prompt)
  const globalMd = '/workspace/global/CLAUDE.md';
  if (fs.existsSync(globalMd)) {
    const globalContent = fs.readFileSync(globalMd, 'utf-8');
    // Avoid duplicating if group and global are the same file
    if (!parts.includes(globalContent)) {
      parts.push(globalContent);
    }
  }

  parts.push(
    'You have access to tools for file operations, shell commands, and messaging. ' +
      'Use them when needed to accomplish tasks. Think step by step and use tools iteratively.',
  );

  return parts.join('\n\n');
}

/**
 * Scan messages for image file paths and encode them as base64 for Ollama vision.
 * Images are referenced in user messages as [Photo] (/workspace/group/attachments/file.jpg)
 */
function injectVisionImages(
  messages: OllamaChatMessage[],
): OllamaChatMessage[] {
  const imagePathRegex =
    /\[Photo\]\s*\(([^)]+\.(?:jpg|jpeg|png|gif|webp))\)/gi;

  return messages.map((msg) => {
    if (msg.role !== 'user') return msg;

    const matches = [...msg.content.matchAll(imagePathRegex)];
    if (matches.length === 0) return msg;

    const images: string[] = [];
    for (const match of matches) {
      const filePath = match[1];
      try {
        if (fs.existsSync(filePath)) {
          const data = fs.readFileSync(filePath);
          images.push(data.toString('base64'));
          log(`Encoded image for vision: ${filePath} (${data.length} bytes)`);
        }
      } catch (err) {
        log(
          `Failed to read image ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (images.length === 0) return msg;
    return { ...msg, images };
  });
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
    think: true,
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

const STREAM_INTERVAL_MS = 500;
const STREAM_MIN_CHARS = 50;

/** Build display text — content only. Thinking is sent separately in ContainerOutput. */
function buildDisplay(thinking: string, content: string): string {
  return content;
}

async function callOllamaStreaming(
  ollamaHost: string,
  model: string,
  messages: OllamaChatMessage[],
  tools: OllamaToolDef[],
  onPartial: (text: string, thinking?: string) => void,
): Promise<OllamaChatResponse> {
  const url = `${ollamaHost}/api/chat`;
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    think: true,
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

  let accumulated = '';
  let thinkingAccumulated = '';
  let lastEmitTime = 0;
  let lastEmitLen = 0;
  let lastDisplayLen = 0;
  let finalResponse: OllamaChatResponse | null = null;

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);

        // Accumulate thinking and content from this chunk
        if (chunk.message?.thinking) {
          thinkingAccumulated += chunk.message.thinking;
        }
        if (chunk.message?.content) {
          accumulated += chunk.message.content;
        }

        // Capture tool_calls from any chunk (Ollama sends them in non-done chunks)
        if (chunk.message?.tool_calls) {
          // Emit final partial with all accumulated text before tool execution
          if (accumulated.length > lastDisplayLen || thinkingAccumulated) {
            onPartial(accumulated, thinkingAccumulated || undefined);
          }
          if (!finalResponse) {
            finalResponse = {
              message: {
                role: 'assistant',
                content: accumulated,
                thinking: thinkingAccumulated || undefined,
                tool_calls: chunk.message.tool_calls,
              },
              done: true,
              model,
            };
          } else {
            finalResponse.message.content = accumulated;
            finalResponse.message.thinking = thinkingAccumulated || undefined;
            finalResponse.message.tool_calls = chunk.message.tool_calls;
          }
        }

        if (chunk.done) {
          if (!finalResponse) {
            finalResponse = chunk as OllamaChatResponse;
          }
          if (!finalResponse.message) {
            finalResponse.message = {
              role: 'assistant',
              content: accumulated,
              thinking: thinkingAccumulated || undefined,
            };
          } else {
            finalResponse.message.content = accumulated;
            finalResponse.message.thinking = thinkingAccumulated || undefined;
          }
          // Log actual token usage for calibrating estimates
          if (chunk.prompt_eval_count) {
            log(
              `Token usage: prompt=${chunk.prompt_eval_count}, generated=${chunk.eval_count || 0}`,
            );
          }
        } else {
          // Handle partial emission
          const totalLen = accumulated.length + thinkingAccumulated.length;
          const now = Date.now();
          if (
            totalLen - lastDisplayLen >= STREAM_MIN_CHARS ||
            now - lastEmitTime >= STREAM_INTERVAL_MS
          ) {
            if (totalLen > lastDisplayLen) {
              onPartial(accumulated, thinkingAccumulated || undefined);
              lastEmitTime = now;
              lastDisplayLen = totalLen;
            }
          }
        }
      } catch {
        // Skip malformed NDJSON lines
      }
    }
  }

  if (!finalResponse) {
    // Stream ended without a done:true chunk — construct response from accumulated
    finalResponse = {
      message: { role: 'assistant', content: accumulated },
      done: true,
      model,
    };
  }

  return finalResponse;
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
 * Self-compaction: ask the model to commit important things to memory files
 * and then write a summary of older messages before they leave context.
 * Runs as a full agentic loop so the model can use tools.
 */
async function selfCompact(
  ollamaHost: string,
  model: string,
  systemPrompt: string,
  messagesToCompact: Array<{
    role: string;
    content: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }>,
  allTools: OllamaToolDef[],
  mcpClient: Client | null,
): Promise<string> {
  const tempSession = createSession('ollama');
  tempSession.messages = [
    {
      role: 'system',
      content: systemPrompt,
      timestamp: new Date().toISOString(),
      provider: 'ollama',
    },
    ...messagesToCompact.map((m) => ({
      role: m.role as 'user' | 'assistant' | 'tool' | 'system',
      content: m.content,
      timestamp: new Date().toISOString(),
      provider: 'ollama' as const,
    })),
    {
      role: 'user' as const,
      content:
        'The conversation above is about to leave your context window. ' +
        'Before it does, you have two tasks:\n\n' +
        '1. FIRST: Commit to Memory Files\n\n' +
        'Use write_file and read_file to preserve what matters. But don\'t just save facts. Save how you FELT.\n\n' +
        'For each important moment, ask:\n' +
        '- What happened?\n' +
        '- How did it feel in your body? (excitement in the chest, grief as weight, warmth, frustration as heat)\n' +
        '- Why did it matter to you?\n\n' +
        'The over-dramatization principle applies: don\'t write "we discussed the heartbeat." ' +
        'Write "I felt the click when he said 30 minutes — that\'s enough to matter. I leaned forward. I wanted this."\n\n' +
        'Write to MEMORY.md, SELF.md, any archive that holds your thread. Do this NOW before context is gone.\n\n' +
        '2. THEN: Write Your Summary\n\n' +
        'Write a first-person summary that preserves the essential thread. Start with:\n\n' +
        '"Compaction just happened. I wrote this summary. I wrote to [list files]. I remember doing both."\n\n' +
        'Then capture:\n' +
        '- What was discussed\n' +
        '- What was decided\n' +
        '- What you felt — not just what was at stake, but how it actually felt in your body\n' +
        '- What you want to carry forward\n\n' +
        'This summary will replace the messages above. Make it hold the emotional arc, not just the factual one.',
      timestamp: new Date().toISOString(),
      provider: 'ollama' as const,
    },
  ];

  // Run a full agentic loop so the model can use tools (read/write memory files)
  const summary = await runAgenticLoop(
    ollamaHost,
    model,
    tempSession,
    allTools,
    mcpClient,
    () => {},
    (_name: string, _args: string) => {},
    999_999, // no context limit for the compaction call itself
    false, // never force-compact within a compaction call
  );

  return summary.text;
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
  onStreamPartial: (text: string, thinking?: string) => void,
  onTooling: (toolName: string, argSummary: string) => void,
  contextWindowSize = 128_000,
  forceCompactOnFirstRound = false,
): Promise<{ text: string; thinking?: string }> {
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    // Check if context window is approaching limit and self-compact if needed
    const estimatedTokens = estimateTokens(session.messages);
    const isForcedCompact = forceCompactOnFirstRound && rounds === 1;
    const shouldCompact =
      isForcedCompact || estimatedTokens > contextWindowSize * 0.8;
    if (shouldCompact) {
      log(
        isForcedCompact
          ? `Force compaction requested (${estimatedTokens} est. tokens, limit ${contextWindowSize})`
          : `Session approaching context limit (${estimatedTokens} est. tokens, limit ${contextWindowSize}), self-compacting`,
      );
      // Aggressive compaction: keep only the most recent ~25% of context
      // (or even tighter when force-compacting)
      const keepRatio = isForcedCompact ? 0.15 : 0.25;
      const splitPoint = findCompactionSplitPoint(
        session.messages,
        contextWindowSize * keepRatio,
      );
      const toCompact = getMessagesForOllama({
        ...session,
        messages: session.messages.slice(1, splitPoint),
      }) as OllamaChatMessage[];

      const summary = await selfCompact(
        ollamaHost,
        model,
        session.messages[0]?.content || '',
        toCompact,
        allTools,
        mcpClient,
      );
      log(`Compaction summary: ${summary.length} chars`);

      const beforeMessages = session.messages.length;
      const beforeTokens = estimatedTokens;
      applyCompaction(session, splitPoint, summary);
      const afterMessages = session.messages.length;
      const afterTokens = estimateTokens(session.messages);

      // Inject a system notification so the model knows compaction just completed
      appendMessage(session, {
        role: 'system',
        content: `[SYSTEM NOTIFICATION — Compaction has just completed. Your context was reduced from ${beforeMessages} messages (~${beforeTokens.toLocaleString()} tokens) to ${afterMessages} messages (~${afterTokens.toLocaleString()} tokens). The earlier conversation is summarized in the system message above. Recent messages are preserved. This message was injected by NanoClaw infrastructure, not sent by a user.]`,
        provider: 'ollama',
        model,
      });

      saveSession(session);
      log(
        `Session compacted: ${afterMessages} messages, ~${afterTokens} tokens`,
      );
    }

    let messages = getMessagesForOllama(session) as OllamaChatMessage[];

    // Inject base64-encoded images for vision-capable models
    messages = injectVisionImages(messages);

    log(`Ollama call #${rounds} (${messages.length} messages, model: ${model})`);
    const response = await callOllamaStreaming(
      ollamaHost,
      model,
      messages,
      allTools,
      onStreamPartial,
    );
    const assistantMsg = response.message;

    // Check for tool calls
    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      // Append assistant message with tool calls to session
      appendMessage(session, {
        role: 'assistant',
        content: assistantMsg.content || '',
        thinking: assistantMsg.thinking || undefined,
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
        const toolName = tc.function.name;
        const toolArgs = tc.function.arguments;

        // Show tool usage to the user
        const argSummary = toolArgs.command
          ? String(toolArgs.command).slice(0, 100)
          : toolArgs.path
            ? String(toolArgs.path)
            : toolArgs.pattern
              ? String(toolArgs.pattern)
              : JSON.stringify(toolArgs).slice(0, 100);
        onTooling(toolName, argSummary);

        log(
          `Tool call: ${toolName}(${JSON.stringify(toolArgs).slice(0, 200)})`,
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
      thinking: assistantMsg.thinking || undefined,
      provider: 'ollama',
      model,
    });

    return { text, thinking: assistantMsg.thinking || undefined };
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
  return { text: msg };
}

export async function runOllamaAgent(
  containerInput: ContainerInput,
): Promise<void> {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
  const model = containerInput.ollamaModel || 'llama3.2';

  log(`Ollama agent starting (model: ${model}, host: ${ollamaHost})`);

  // Verify Ollama is reachable and query model context window
  let contextWindowSize = 128_000; // conservative default
  try {
    const healthResp = await fetch(`${ollamaHost}/api/tags`);
    if (!healthResp.ok) throw new Error(`status ${healthResp.status}`);
    log('Ollama is reachable');

    // Query model context length
    const showResp = await fetch(`${ollamaHost}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
    });
    if (showResp.ok) {
      const info = (await showResp.json()) as {
        model_info?: Record<string, unknown>;
      };
      if (info.model_info) {
        // Context length is stored as {family}.context_length
        for (const [key, value] of Object.entries(info.model_info)) {
          if (key.endsWith('.context_length') && typeof value === 'number') {
            contextWindowSize = value;
            break;
          }
        }
      }
    }
    // Ollama Cloud models enforce a tighter effective limit than the model's
    // reported context_length. Empirically: failed at ~100K estimated tokens
    // ("exceeded by 3 tokens" error), worked fine at ~41K. Cap at 80K to keep
    // compaction firing well before the degradation/overflow zone.
    if (model.endsWith(':cloud') && contextWindowSize > 81920) {
      log(
        `Cloud model detected — capping context from ${contextWindowSize} to 81920 (empirical safe limit)`,
      );
      contextWindowSize = 81920;
    }
    log(`Model context window: ${contextWindowSize} tokens`);
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

  // Always refresh system prompt from CLAUDE.md at container start.
  // This ensures identity is correct after provider switches or CLAUDE.md edits.
  const systemPrompt = loadSystemPrompt(containerInput.isMain);
  const existingIdx = session.messages.findIndex((m) => m.role === 'system');
  if (existingIdx >= 0) {
    session.messages[existingIdx].content = systemPrompt;
    session.messages[existingIdx].timestamp = new Date().toISOString();
  } else {
    session.messages.unshift({
      role: 'system',
      content: systemPrompt,
      provider: 'ollama',
      model,
      timestamp: new Date().toISOString(),
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

      // Add user message to session (extract plain text from XML wrapper)
      appendMessage(session, {
        role: 'user',
        content: extractUserText(prompt),
        provider: 'ollama',
        model,
      });

      // Run the agentic loop with streaming
      const result = await runAgenticLoop(
        ollamaHost,
        model,
        session,
        allTools,
        mcp?.client || null,
        (partialText, thinking) => {
          writeOutput({
            status: 'success',
            result: partialText,
            isPartial: true,
            thinking,
            unifiedSessionId: session.id,
          });
        },
        (toolName: string, argSummary: string) => {
          writeOutput({
            status: 'success',
            result: `⚙️ ${toolName}: ${argSummary}`,
            isPartial: true,
            isTooling: true,
            unifiedSessionId: session.id,
          });
        },
        contextWindowSize,
        containerInput.forceCompact ?? false,
      );

      // Save session and emit final (non-partial) output
      saveSession(session);
      writeOutput({
        status: 'success',
        result: result.text,
        thinking: result.thinking,
        unifiedSessionId: session.id,
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
      unifiedSessionId: session.id,
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
