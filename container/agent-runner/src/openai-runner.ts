/**
 * OpenAI Agent Runner for NanoClaw
 * Drop-in replacement for the Claude Agent SDK query() loop.
 * Calls OpenAI-compatible APIs directly with tool/function calling.
 * Speaks MCP protocol to tool servers via JSON-RPC over stdio.
 *
 * Same stdin/stdout/IPC protocol as the Claude runner.
 */

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

// --- Types ---

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpClient {
  process: ChildProcess;
  serverName: string;
  tools: McpTool[];
  pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextId: number;
  buffer: string;
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

// --- Logging ---

function log(msg: string): void {
  process.stderr.write(`[openai-runner] ${msg}\n`);
}

// --- MCP Client ---

function spawnMcpServer(name: string, config: McpServerConfig): McpClient {
  const env = { ...process.env, ...config.env };
  const proc = spawn(config.command, config.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  const client: McpClient = {
    process: proc,
    serverName: name,
    tools: [],
    pendingRequests: new Map(),
    nextId: 1,
    buffer: '',
  };

  proc.stdout!.on('data', (chunk: Buffer) => {
    client.buffer += chunk.toString();
    // Process complete JSON-RPC messages (newline-delimited)
    const lines = client.buffer.split('\n');
    client.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && client.pendingRequests.has(msg.id)) {
          const pending = client.pendingRequests.get(msg.id)!;
          client.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || 'MCP error'));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    // Log MCP server stderr for debugging
    const text = chunk.toString().trim();
    if (text) log(`[MCP:${name}] ${text}`);
  });

  proc.on('exit', (code) => {
    log(`MCP server ${name} exited with code ${code}`);
  });

  return client;
}

function mcpRequest(client: McpClient, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = client.nextId++;
    client.pendingRequests.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    client.process.stdin!.write(msg + '\n');

    // Timeout after 30 seconds
    setTimeout(() => {
      if (client.pendingRequests.has(id)) {
        client.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }
    }, 30000);
  });
}

async function initMcpServer(client: McpClient): Promise<void> {
  // Initialize
  await mcpRequest(client, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'nanoclaw-openai-runner', version: '1.0.0' },
  });

  // Send initialized notification
  client.process.stdin!.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
  );

  // List tools
  const result = await mcpRequest(client, 'tools/list') as { tools: McpTool[] };
  client.tools = result.tools || [];
  log(`MCP:${client.serverName} - ${client.tools.length} tools: ${client.tools.map(t => t.name).join(', ')}`);
}

async function callMcpTool(
  client: McpClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await mcpRequest(client, 'tools/call', {
    name: toolName,
    arguments: args,
  }) as { content: Array<{ type: string; text?: string }> };

  return (result.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('\n');
}

// --- Built-in tools (Bash, Read, Write, etc.) ---

async function executeBuiltinTool(name: string, args: Record<string, unknown>): Promise<string> {
  const { execSync } = await import('child_process');

  switch (name) {
    case 'Bash': {
      const command = args.command as string;
      try {
        const result = execSync(command, {
          cwd: '/workspace/group',
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf-8',
          env: process.env,
        });
        return result || '(no output)';
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return `Exit code: ${e.status || 1}\n${e.stderr || ''}${e.stdout || ''}`;
      }
    }
    case 'Read': {
      const filePath = args.file_path as string;
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch (err: unknown) {
        return `Error reading file: ${(err as Error).message}`;
      }
    }
    case 'Write': {
      const filePath = args.file_path as string;
      const content = args.content as string;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        return `File written: ${filePath}`;
      } catch (err: unknown) {
        return `Error writing file: ${(err as Error).message}`;
      }
    }
    case 'Glob': {
      const { execSync: exec } = await import('child_process');
      const pattern = args.pattern as string;
      const searchPath = (args.path as string) || '/workspace/group';
      try {
        const result = exec(`find ${searchPath} -path '${pattern}' -type f 2>/dev/null | head -50`, {
          encoding: 'utf-8',
          timeout: 10000,
        });
        return result || '(no matches)';
      } catch {
        return '(no matches)';
      }
    }
    case 'Grep': {
      const { execSync: exec } = await import('child_process');
      const pattern = args.pattern as string;
      const searchPath = (args.path as string) || '/workspace/group';
      try {
        const result = exec(
          `grep -r --include='*' -l ${JSON.stringify(pattern)} ${searchPath} 2>/dev/null | head -20`,
          { encoding: 'utf-8', timeout: 10000 },
        );
        return result || '(no matches)';
      } catch {
        return '(no matches)';
      }
    }
    default:
      return `Unknown built-in tool: ${name}`;
  }
}

// --- OpenAI API ---

function callOpenAI(
  messages: OpenAIMessage[],
  tools: OpenAITool[],
  model: string,
  maxTokens: number,
): Promise<{ choices: Array<{ message: OpenAIMessage; finish_reason: string }>; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  // Call OpenAI directly — not through the credential proxy
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const url = new URL('/v1/chat/completions', baseUrl);

  const reqBody: Record<string, unknown> = {
    model,
    messages,
    max_completion_tokens: maxTokens,
  };
  if (tools.length > 0) reqBody.tools = tools;
  const body = JSON.stringify(reqBody);
  log(`OpenAI request: model=${model}, messages=${messages.length}, tools=${tools.length}, bodySize=${body.length}`);

  return new Promise((resolve, reject) => {
    const makeReq = url.protocol === 'https:' ? https.request : http.request;
    const req = makeReq(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            const parsed = JSON.parse(text);
            if (parsed.error) {
              reject(new Error(`OpenAI API error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`Failed to parse OpenAI response: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --- Image handling ---

const IMAGE_PATTERN = /\[Photo: ([^\]]+)\]/g;

function buildUserContent(text: string): string | OpenAIContentPart[] {
  const matches = [...text.matchAll(IMAGE_PATTERN)];
  if (matches.length === 0) return text;

  const parts: OpenAIContentPart[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    // Add text before this image
    const before = text.slice(lastIndex, match.index).trim();
    if (before) parts.push({ type: 'text', text: before });

    const imagePath = match[1].trim();
    try {
      if (fs.existsSync(imagePath)) {
        const imageData = fs.readFileSync(imagePath);
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType =
          ext === '.png' ? 'image/png' :
          ext === '.gif' ? 'image/gif' :
          ext === '.webp' ? 'image/webp' :
          'image/jpeg';
        const base64 = imageData.toString('base64');
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64}` },
        });
        log(`Encoded image: ${imagePath} (${Math.round(base64.length / 1024)}KB base64)`);
      } else {
        parts.push({ type: 'text', text: `[Image not found: ${imagePath}]` });
      }
    } catch {
      parts.push({ type: 'text', text: `[Failed to read image: ${imagePath}]` });
    }

    lastIndex = match.index! + match[0].length;
  }

  // Add remaining text after last image
  const after = text.slice(lastIndex).trim();
  if (after) parts.push({ type: 'text', text: after });

  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

// --- Agent Loop ---

const BUILTIN_TOOLS = ['Bash', 'Read', 'Write', 'Glob', 'Grep'];

export async function runOpenAIAgent(
  prompt: string,
  systemPrompt: string,
  model: string,
  mcpConfigs: Record<string, McpServerConfig>,
  conversationHistory?: OpenAIMessage[],
): Promise<{ result: string | null; error?: string; history: OpenAIMessage[] }> {
  // Start MCP servers
  const mcpClients: McpClient[] = [];
  for (const [name, config] of Object.entries(mcpConfigs)) {
    try {
      const client = spawnMcpServer(name, config);
      await initMcpServer(client);
      mcpClients.push(client);
    } catch (err) {
      log(`Failed to start MCP server ${name}: ${(err as Error).message}`);
    }
  }

  // Build tool definitions
  const tools: OpenAITool[] = [];

  // Built-in tools
  for (const name of BUILTIN_TOOLS) {
    tools.push({
      type: 'function',
      function: {
        name,
        description: getBuiltinDescription(name),
        parameters: getBuiltinSchema(name),
      },
    });
  }

  // MCP tools
  const mcpToolMap = new Map<string, { client: McpClient; toolName: string }>();
  for (const client of mcpClients) {
    for (const tool of client.tools) {
      const qualifiedName = `mcp__${client.serverName}__${tool.name}`;
      mcpToolMap.set(qualifiedName, { client, toolName: tool.name });
      tools.push({
        type: 'function',
        function: {
          name: qualifiedName,
          description: tool.description || '',
          parameters: cleanSchema(tool.inputSchema),
        },
      });
    }
  }

  // Filter out invalid tools and trim large MCP servers to essential tools
  const MOLTBOOK_ESSENTIAL = new Set([
    'moltbook_digest', 'moltbook_post', 'moltbook_post_create', 'moltbook_comment',
    'moltbook_vote', 'moltbook_search', 'moltbook_submolts', 'moltbook_profile',
    'moltbook_follow', 'moltbook_state', 'moltbook_thread_diff',
    'moltbook_trust', 'moltbook_karma', 'moltbook_pending',
    'moltbook_dedup_check', 'moltbook_dedup_record',
    'log_engagement', 'human_review_flag', 'human_review_list',
    'engagement_quality', 'knowledge_read',
  ]);

  const filteredTools = tools.filter((t) => {
    if (!t.function.name) return false;
    // Only keep essential moltbook tools (full set is 200+, OpenAI limit is 128)
    if (t.function.name.startsWith('mcp__moltbook__')) {
      const toolName = t.function.name.replace('mcp__moltbook__', '');
      return MOLTBOOK_ESSENTIAL.has(toolName);
    }
    return true;
  });

  const dropped = tools.length - filteredTools.length;
  if (dropped > 0) log(`Filtered ${dropped} non-essential moltbook tools`);

  const MAX_TOOLS = 128;
  if (filteredTools.length > MAX_TOOLS) {
    log(`WARNING: ${filteredTools.length} tools still exceeds limit of ${MAX_TOOLS}, trimming`);
    filteredTools.length = MAX_TOOLS;
  }
  tools.length = 0;
  tools.push(...filteredTools);
  log(`Total tools: ${tools.length} (${BUILTIN_TOOLS.length} built-in + ${tools.length - BUILTIN_TOOLS.length} MCP)`);

  // Build messages — carry forward conversation history if provided
  // Detect [Photo: /path] in user messages and convert to multimodal content
  const messages: OpenAIMessage[] = conversationHistory
    ? [...conversationHistory, { role: 'user', content: buildUserContent(prompt) }]
    : [{ role: 'system', content: systemPrompt }, { role: 'user', content: buildUserContent(prompt) }];

  // Agent loop
  const MAX_ITERATIONS = 50;
  let lastResult: string | null = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    log(`Iteration ${i + 1}: calling ${model}...`);

    let response;
    try {
      response = await callOpenAI(messages, tools, model, 8192);
      // Record token usage directly to the DB
      if (response.usage) {
        try {
          const dbPath = '/workspace/project/store/messages.db';
          if (fs.existsSync(dbPath)) {
            const { execSync } = await import('child_process');
            const containerName = process.env.HOSTNAME || 'openai-runner';
            const groupFolder = process.env.NANOCLAW_GROUP_FOLDER || 'unknown';
            execSync(`sqlite3 "${dbPath}" "INSERT INTO token_usage (container_name, group_folder, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, recorded_at) VALUES ('${containerName}', '${groupFolder}', '${model}', ${response.usage.prompt_tokens || 0}, ${response.usage.completion_tokens || 0}, 0, 0, '${new Date().toISOString()}');"`, { timeout: 5000 });
          }
        } catch {
          // Don't let usage tracking break the agent
        }
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      log(`OpenAI API error: ${errMsg}`);
      cleanup(mcpClients);
      return { result: null, error: errMsg, history: messages };
    }

    const choice = response.choices?.[0];
    if (!choice) {
      log('No choices in response');
      cleanup(mcpClients);
      return { result: null, error: 'No response from model', history: messages };
    }

    const msg = choice.message;

    // Add assistant message to history
    messages.push(msg);

    // If no tool calls, we're done
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      lastResult = typeof msg.content === 'string' ? msg.content : (msg.content ? JSON.stringify(msg.content) : '');
      log(`Final response: ${lastResult.slice(0, 200)}`);
      break;
    }

    // Execute tool calls
    log(`Tool calls: ${msg.tool_calls.map(tc => tc.function.name).join(', ')}`);

    for (const tc of msg.tool_calls) {
      const toolName = tc.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }

      let toolResult: string;
      try {
        if (BUILTIN_TOOLS.includes(toolName)) {
          toolResult = await executeBuiltinTool(toolName, args);
        } else if (mcpToolMap.has(toolName)) {
          const { client, toolName: mcpToolName } = mcpToolMap.get(toolName)!;
          toolResult = await callMcpTool(client, mcpToolName, args);
        } else {
          toolResult = `Unknown tool: ${toolName}`;
        }
      } catch (err) {
        toolResult = `Tool error: ${(err as Error).message}`;
      }

      // Truncate very long results
      if (toolResult.length > 50000) {
        toolResult = toolResult.slice(0, 50000) + '\n... (truncated)';
      }

      messages.push({
        role: 'tool',
        content: toolResult,
        tool_call_id: tc.id,
      });
    }
  }

  cleanup(mcpClients);
  return { result: lastResult, history: messages };
}

function cleanup(clients: McpClient[]): void {
  for (const client of clients) {
    try {
      client.process.kill();
    } catch {
      // ignore
    }
  }
}

function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...schema };
  delete cleaned['format'];
  if (cleaned.properties && typeof cleaned.properties === 'object') {
    const props = cleaned.properties as Record<string, Record<string, unknown>>;
    const cleanedProps: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(props)) {
      cleanedProps[key] = cleanSchema(val);
    }
    cleaned.properties = cleanedProps;
  }
  if (cleaned.items && typeof cleaned.items === 'object') {
    cleaned.items = cleanSchema(cleaned.items as Record<string, unknown>);
  }
  return cleaned;
}

function getBuiltinDescription(name: string): string {
  const descriptions: Record<string, string> = {
    Bash: 'Execute a bash command and return its output',
    Read: 'Read a file from the filesystem',
    Write: 'Write content to a file',
    Glob: 'Find files matching a glob pattern',
    Grep: 'Search file contents for a pattern',
  };
  return descriptions[name] || name;
}

function getBuiltinSchema(name: string): Record<string, unknown> {
  const schemas: Record<string, Record<string, unknown>> = {
    Bash: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
      },
      required: ['command'],
    },
    Read: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
      },
      required: ['file_path'],
    },
    Write: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to write to' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['file_path', 'content'],
    },
    Glob: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match' },
        path: { type: 'string', description: 'Directory to search in' },
      },
      required: ['pattern'],
    },
    Grep: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in' },
      },
      required: ['pattern'],
    },
  };
  return schemas[name] || { type: 'object', properties: {} };
}
