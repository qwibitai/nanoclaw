import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { OpencodeClient } from '@opencode-ai/sdk';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'attachment'; filename: string; mimeType: string; size: number };

interface StructuredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  timestamp: string;
  sender_name?: string;
}

interface ContainerInput {
  prompt: string;
  messages?: StructuredMessage[];
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  traceId: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface IpcMessage {
  type: 'message';
  text: string;
}

interface OpenCodePart {
  type: 'text';
  text: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

let currentTraceId: string = 'unknown';

function log(message: string): void {
  console.error(`[agent-runner] [${currentTraceId}] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {}
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(
          fs.readFileSync(filePath, 'utf-8'),
        ) as IpcMessage;
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function extractResponseText(parts: unknown[]): string {
  const textParts: string[] = [];
  for (const part of parts) {
    if (part && typeof part === 'object' && 'type' in part) {
      const typedPart = part as { type: string; text?: string };
      if (typedPart.type === 'text' && typedPart.text) {
        textParts.push(typedPart.text);
      }
    }
  }
  return textParts.join('');
}

/**
 * Convert structured messages to OpenCode parts format.
 * Falls back to legacy prompt if messages not provided.
 */
function messagesToOpenCodeParts(
  messages: StructuredMessage[] | undefined,
  legacyPrompt: string,
): Array<{ role: string; parts: OpenCodePart[] }> {
  // Fallback to legacy prompt if messages not provided
  if (!messages || messages.length === 0) {
    return [{ role: 'user', parts: [{ type: 'text', text: legacyPrompt }] }];
  }

  return messages.map((m) => ({
    role: m.role,
    parts: m.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => ({ type: 'text', text: c.text })),
  }));
}

async function waitForAssistantResponse(
  client: OpencodeClient,
  sessionId: string,
  timeoutMs: number = 300000,
): Promise<{ text: string; success: boolean }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const messagesResponse = await client.session.messages({
        path: { id: sessionId },
      });

      if (messagesResponse.error) {
        log(
          `Error getting messages: ${JSON.stringify(messagesResponse.error)}`,
        );
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const messages = messagesResponse.data;
      if (!messages || messages.length === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const assistantMessages = messages.filter(
        (m: unknown) =>
          m &&
          typeof m === 'object' &&
          'role' in m &&
          (m as { role: string }).role === 'assistant',
      );

      if (assistantMessages.length > 0) {
        const lastMessage = assistantMessages[assistantMessages.length - 1] as {
          parts?: unknown[];
        };
        if (lastMessage.parts && lastMessage.parts.length > 0) {
          const text = extractResponseText(lastMessage.parts);
          if (text) return { text, success: true };
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      log(
        `Error polling for messages: ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return { text: '', success: false };
}

interface LLMHealthResult {
  ok: boolean;
  error?: string;
  modelsAvailable?: number;
}

interface LLMConfig {
  provider: Record<
    string,
    { name?: string; options: { baseURL: string; apiKey: string } }
  >;
  model: string;
}

/**
 * Parse LLM configuration from environment variables.
 * Supports NANOCLAW_LLM_CONFIG (JSON) with fallback to legacy env vars.
 */
function parseLLMConfig(): LLMConfig {
  // 1. Try NANOCLAW_LLM_CONFIG first
  const configJson = process.env.NANOCLAW_LLM_CONFIG;
  if (configJson) {
    try {
      const cfg = JSON.parse(configJson) as LLMConfig;
      // Validate basic structure
      if (!cfg.provider || typeof cfg.provider !== 'object') {
        throw new Error('NANOCLAW_LLM_CONFIG must have provider object');
      }
      if (!cfg.model || typeof cfg.model !== 'string') {
        throw new Error('NANOCLAW_LLM_CONFIG must have model string');
      }
      return cfg;
    } catch (e) {
      throw new Error(
        `Invalid NANOCLAW_LLM_CONFIG: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 2. Synthesize from legacy env vars
  const baseURL =
    process.env.NANOCLAW_LLM_BASE_URL || 'http://host.docker.internal:1234/v1';
  const apiKey = process.env.NANOCLAW_LLM_API_KEY || 'not-needed';
  const modelId = process.env.NANOCLAW_LLM_MODEL_ID || 'default';

  return {
    provider: {
      'openai-compatible': {
        options: { baseURL, apiKey },
      },
    },
    model: `openai-compatible/${modelId}`,
  };
}

/**
 * Apply optional model override from NANOCLAW_LLM_MODEL.
 */
function applyModelOverride(cfg: LLMConfig): LLMConfig {
  const override = process.env.NANOCLAW_LLM_MODEL;
  if (!override) return cfg;

  // If override contains '/', use as-is; otherwise prefix with provider type
  if (override.includes('/')) {
    cfg.model = override;
  } else {
    // Extract provider type from existing model
    const providerType = cfg.model.split('/')[0];
    cfg.model = `${providerType}/${override}`;
  }
  return cfg;
}

/**
 * Extract the base URL from the provider configuration.
 * Uses the provider type from the model string to find the matching provider config.
 */
function getBaseURLFromConfig(cfg: LLMConfig): string | null {
  const providerType = cfg.model.split('/')[0];
  const provider = cfg.provider[providerType];
  if (provider?.options?.baseURL) {
    return provider.options.baseURL;
  }
  // Fallback: try any provider if only one exists
  const providerKeys = Object.keys(cfg.provider);
  if (providerKeys.length === 1) {
    const singleProvider = cfg.provider[providerKeys[0]];
    if (singleProvider?.options?.baseURL) {
      return singleProvider.options.baseURL;
    }
  }
  return null;
}

/**
 * Get display name for the provider (for logging).
 */
function getProviderDisplayName(cfg: LLMConfig): string {
  const providerType = cfg.model.split('/')[0];
  const provider = cfg.provider[providerType];
  return provider?.name || providerType;
}

async function checkLLMHealth(
  url: string,
  maxRetries: number = 3,
  retryDelayMs: number = 2000,
): Promise<LLMHealthResult> {
  let lastError: string = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${url}/models`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${response.statusText}`;
        log(`LLM health check attempt ${attempt} failed: ${lastError}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
        continue;
      }

      const data = (await response.json()) as { data?: Array<{ id: string }> };
      const modelsAvailable = data.data?.length ?? 0;

      if (modelsAvailable === 0) {
        lastError = 'No models available';
        log(`LLM health check attempt ${attempt}: ${lastError}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
        continue;
      }

      log(`LLM is healthy with ${modelsAvailable} models available`);
      return { ok: true, modelsAvailable };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = 'Connection timeout (5s)';
      } else {
        lastError = err instanceof Error ? err.message : String(err);
      }
      log(`LLM health check attempt ${attempt} failed: ${lastError}`);

      if (attempt < maxRetries) {
        log(`Retrying in ${retryDelayMs}ms...`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  return {
    ok: false,
    error: `LLM server is not responding after ${maxRetries} attempts. Last error: ${lastError}`,
  };
}

async function createOpencodeServer(
  directory: string,
  containerInput: ContainerInput,
): Promise<{ url: string; close(): void }> {
  const hostname = '127.0.0.1';
  const port = 4096;
  const timeout = 10000;

  // Build MCP server configuration for NanoClaw IPC
  const mcpServerConfig = {
    nanoclaw: {
      type: 'stdio' as const,
      command: 'node',
      args: ['/opt/nanoclaw/ipc-mcp-stdio.js'],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    },
  };

  const llmConfig = applyModelOverride(parseLLMConfig());

  const config = {
    provider: llmConfig.provider,
    model: llmConfig.model,
    mcp: mcpServerConfig,
  };

  const args = ['serve', `--hostname=${hostname}`, `--port=${port}`];
  const proc = spawn('opencode', args, {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
    cwd: directory,
  });

  const url = await new Promise<string>((resolve, reject) => {
    const id = setTimeout(() => {
      proc.kill();
      reject(
        new Error(`Timeout waiting for server to start after ${timeout}ms`),
      );
    }, timeout);

    let output = '';
    proc.stdout?.on('data', (chunk) => {
      output += chunk.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('listening')) {
          const match = line.match(/(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve(match[1]!);
            return;
          }
        }
      }
    });

    proc.stderr?.on('data', (chunk) => {
      output += chunk.toString();
      log(`Server stderr: ${chunk.toString().trim()}`);
    });

    proc.on('exit', (code) => {
      clearTimeout(id);
      reject(new Error(`Server exited with code ${code}. Output: ${output}`));
    });

    proc.on('error', (error) => {
      clearTimeout(id);
      reject(error);
    });
  });

  log(`OpenCode server started at ${url}`);
  return { url, close: () => proc.kill() };
}

async function runQuery(
  client: OpencodeClient,
  prompt: string,
  messages: StructuredMessage[] | undefined,
  sessionId: string | undefined,
  containerInput: ContainerInput,
): Promise<{ newSessionId: string; closedDuringQuery: boolean }> {
  let currentSessionId: string;
  let closedDuringQuery = false;

  if (sessionId) {
    currentSessionId = sessionId;
    log(`Using existing session: ${currentSessionId}`);
  } else {
    log('Creating new session...');
    const createResponse = await client.session.create({
      body: { title: `NanoClaw-${containerInput.groupFolder}` },
    });

    if (createResponse.error) {
      throw new Error(
        `Failed to create session: ${JSON.stringify(createResponse.error)}`,
      );
    }

    const session = createResponse.data as { id: string };
    currentSessionId = session.id;
    log(`Created new session: ${currentSessionId}`);
  }

  let ipcPolling = true;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query');
      closedDuringQuery = true;
      ipcPolling = false;
      return;
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  try {
    const llmConfig = applyModelOverride(parseLLMConfig());
    const modelParts = llmConfig.model.split('/');
    const providerId = modelParts[0] || 'openai-compatible';
    const modelId = modelParts.slice(1).join('/') || 'default';
    const opencodeMessages = messagesToOpenCodeParts(messages, prompt);

    log(
      `Sending ${opencodeMessages.length} messages to session ${currentSessionId}...`,
    );

    const lastMessage = opencodeMessages[opencodeMessages.length - 1];
    const promptResponse = await client.session.prompt({
      path: { id: currentSessionId },
      body: {
        parts: lastMessage.parts,
        model: { providerID: providerId, modelID: modelId },
      },
    });

    if (promptResponse.error) {
      throw new Error(
        `Failed to send prompt: ${JSON.stringify(promptResponse.error)}`,
      );
    }

    log('Waiting for assistant response...');
    const { text, success } = await waitForAssistantResponse(
      client,
      currentSessionId,
    );

    if (!success) {
      throw new Error('Timeout waiting for assistant response');
    }

    log(`Got response (${text.length} chars)`);

    writeOutput({
      status: 'success',
      result: text,
      newSessionId: currentSessionId,
    });
  } finally {
    ipcPolling = false;
  }

  return { newSessionId: currentSessionId, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData) as ContainerInput;
    currentTraceId = containerInput.traceId || 'unknown';
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  let server: { url: string; close(): void } | null = null;
  let client: OpencodeClient | null = null;

  try {
    log('Starting OpenCode server...');
    server = await createOpencodeServer('/workspace/group', containerInput);
    client = createOpencodeClient({ baseUrl: server.url });

    const llmConfig = applyModelOverride(parseLLMConfig());
    const llmUrl = getBaseURLFromConfig(llmConfig);
    const providerName = getProviderDisplayName(llmConfig);
    log(`Using LLM provider: ${providerName}, model: ${llmConfig.model}`);

    if (!llmUrl) {
      const userError =
        '❌ LLM configuration error: Could not determine base URL from provider config.\n\n' +
        'Please ensure your NANOCLAW_LLM_CONFIG includes a valid baseURL in the provider options.';
      log('LLM URL not found in config');
      writeOutput({
        status: 'error',
        result: null,
        error: userError,
      });
      process.exit(1);
    }

    // Check LLM health before proceeding
    log('Checking LLM connectivity...');
    const health = await checkLLMHealth(llmUrl, 3, 2000);
    if (!health.ok) {
      const userError =
        '❌ LLM server is currently unavailable.\n\n' +
        'Please ensure your LLM server is running:\n' +
        '1. For LM Studio: Open the application and load a model in Developer tab\n' +
        '2. For Ollama: Run `ollama serve`\n' +
        '3. For cloud APIs: Verify your API key and endpoint URL\n\n' +
        `Technical details: ${health.error}`;

      log(`LLM health check failed: ${health.error}`);
      writeOutput({
        status: 'error',
        result: null,
        error: userError,
      });
      process.exit(1);
    }

    log(`LLM is ready with ${health.modelsAvailable} models available`);

    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {}

    // Prepare prompt from messages or legacy prompt
    let prompt = containerInput.prompt;
    if (containerInput.messages && containerInput.messages.length > 0) {
      // Use the last message's content as the prompt for backward compatibility
      const lastMessage =
        containerInput.messages[containerInput.messages.length - 1];
      const textContent = lastMessage.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      prompt = textContent || containerInput.prompt;
    }

    if (containerInput.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }
    const pending = drainIpcInput();
    if (pending.length > 0) {
      log(
        `Draining ${pending.length} pending IPC messages into initial prompt`,
      );
      prompt += '\n' + pending.join('\n');
    }

    let sessionId = containerInput.sessionId;

    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      if (!client) {
        throw new Error('Client not initialized');
      }

      const queryResult = await runQuery(
        client,
        prompt,
        containerInput.messages,
        sessionId,
        containerInput,
      );
      sessionId = queryResult.newSessionId;

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
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
      // Clear messages after first use (subsequent turns use IPC)
      containerInput.messages = undefined;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Failed to initialize OpenCode: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: `OpenCode initialization failed: ${errorMessage}`,
    });
    process.exit(1);
  } finally {
    if (server) {
      log('Shutting down OpenCode server...');
      server.close();
    }
  }
}

main();
