import {
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
  type PartListUnion,
} from '@google/genai';

import {
  getRegisteredToolByName,
  getRegisteredTools,
} from '../mcp-tools/server.js';
import type { McpToolDefinition } from '../mcp-tools/types.js';
// Side-effect import: each tool module's top-level registerTools() call
// populates the in-process registry that the helpers above read from.
// Without this import, Gemini would advertise zero tools to the model
// and the founder smoke turn would silently fall back to text-only
// hallucinations (the May-1 <tool_code> leak).
import '../mcp-tools/register-all.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const CONTINUATION_VERSION = 1;

// Hard cap on consecutive tool-execution rounds in a single turn. Gemini
// is allowed to chain N tool calls before producing user-facing text.
// Without a cap, a buggy prompt or a tool that loops on its own output
// would burn unlimited tokens / quota; with the cap we surface a clear
// activity event and let the founder retry instead of silently hanging.
const MAX_TOOL_ROUNDS_PER_TURN = 10;

interface StoredHistory {
  version: number;
  history: Content[];
}

interface ChatLike {
  sendMessageStream(params: { message: PartListUnion }): Promise<AsyncGenerator<GenerateContentResponse>>;
  getHistory(curated?: boolean): Content[];
}

interface GeminiClientLike {
  chats: {
    create(params: { model: string; history?: Content[]; config?: GenerateContentConfig }): ChatLike;
  };
}

interface GeminiProviderDeps {
  client?: GeminiClientLike;
  /**
   * Optional override for the tool catalog. Defaults to
   * `getRegisteredTools()`. Tests use this to inject a fake catalog
   * without touching the global registry.
   */
  toolCatalog?: () => readonly McpToolDefinition[];
  /**
   * Optional override for tool-name lookup. Defaults to
   * `getRegisteredToolByName`. Tests use this in tandem with
   * `toolCatalog` to match the catalog they injected.
   */
  resolveTool?: (name: string) => McpToolDefinition | undefined;
}

function log(message: string): void {
  console.error(`[gemini-provider] ${message}`);
}

function resolveApiKey(env: Record<string, string | undefined>): string {
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY || env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini provider requires GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_AI_API_KEY.');
  }
  return apiKey;
}

function resolveModel(env: Record<string, string | undefined>): string {
  return env.BAGET_GEMINI_MODEL || env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

function buildChatConfig(
  instructions: string | undefined,
  declarations: FunctionDeclaration[],
): GenerateContentConfig | undefined {
  const config: GenerateContentConfig = {};
  if (instructions) config.systemInstruction = instructions;
  if (declarations.length > 0) {
    config.tools = [{ functionDeclarations: declarations }];
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function isLikelyContent(value: unknown): value is Content {
  if (!value || typeof value !== 'object') return false;
  const content = value as { role?: unknown; parts?: unknown };
  if (content.role !== undefined && typeof content.role !== 'string') return false;
  if (content.parts !== undefined && !Array.isArray(content.parts)) return false;
  return true;
}

function deserializeHistory(serialized?: string): Content[] {
  if (!serialized) return [];

  try {
    const parsed = JSON.parse(serialized) as StoredHistory | Content[];
    const history = Array.isArray(parsed)
      ? parsed
      : parsed?.version === CONTINUATION_VERSION && Array.isArray(parsed.history)
        ? parsed.history
        : null;

    if (!history) {
      log('Ignoring continuation with unsupported format');
      return [];
    }

    return history.filter(isLikelyContent);
  } catch {
    log('Ignoring malformed continuation payload');
    return [];
  }
}

function serializeHistory(history: Content[]): string {
  return JSON.stringify({
    version: CONTINUATION_VERSION,
    history,
  } satisfies StoredHistory);
}

function appendChunkText(accumulated: string, chunk: GenerateContentResponse): string {
  return typeof chunk.text === 'string' && chunk.text.length > 0 ? accumulated + chunk.text : accumulated;
}

function buildFunctionDeclarations(
  toolCatalog: () => readonly McpToolDefinition[],
): FunctionDeclaration[] {
  return toolCatalog().map((entry) => {
    const decl: FunctionDeclaration = { name: entry.tool.name };
    if (entry.tool.description) decl.description = entry.tool.description;
    // MCP `inputSchema` is already a JSON Schema object describing the
    // arguments. Gemini accepts raw JSON Schema via `parametersJsonSchema`,
    // which sidesteps the conversion to its native `Schema` enum-based
    // shape (Type.OBJECT, Type.STRING, …).
    if (entry.tool.inputSchema) {
      decl.parametersJsonSchema = entry.tool.inputSchema;
    }
    return decl;
  });
}

function functionResponseToPart(
  call: FunctionCall,
  response: Record<string, unknown>,
): Part {
  return {
    functionResponse: {
      id: call.id,
      name: call.name,
      response,
    },
  };
}

async function executeToolCall(
  call: FunctionCall,
  resolveTool: (name: string) => McpToolDefinition | undefined,
): Promise<Part> {
  if (!call.name) {
    return functionResponseToPart(call, { error: 'Function call missing name' });
  }
  const tool = resolveTool(call.name);
  if (!tool) {
    return functionResponseToPart(call, { error: `Unknown tool: ${call.name}` });
  }
  try {
    const result = await tool.handler(call.args ?? {});
    const content = result.content ?? [];
    const text = content
      .map((c) => {
        if (c.type === 'text' && typeof (c as { text?: unknown }).text === 'string') {
          return (c as { text: string }).text;
        }
        return '';
      })
      .join('');
    if (result.isError) {
      return functionResponseToPart(call, { error: text || 'Tool reported error with no message' });
    }
    return functionResponseToPart(call, { output: text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`tool ${call.name} threw: ${msg}`);
    return functionResponseToPart(call, { error: msg });
  }
}

export class GeminiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly client: GeminiClientLike;
  private readonly model: string;
  private readonly toolCatalog: () => readonly McpToolDefinition[];
  private readonly resolveTool: (name: string) => McpToolDefinition | undefined;

  constructor(options: ProviderOptions = {}, deps: GeminiProviderDeps = {}) {
    const env = options.env ?? {};
    const apiKey = resolveApiKey(env);

    this.model = resolveModel(env);
    this.client = deps.client ?? new GoogleGenAI({ apiKey });
    this.toolCatalog = deps.toolCatalog ?? (() => getRegisteredTools());
    this.resolveTool = deps.resolveTool ?? ((name: string) => getRegisteredToolByName(name));
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const declarations = buildFunctionDeclarations(this.toolCatalog);
    const pending: string[] = [input.prompt];
    const chat = this.client.chats.create({
      model: this.model,
      history: deserializeHistory(input.continuation),
      config: buildChatConfig(input.systemContext?.instructions, declarations),
    });
    const resolveTool = this.resolveTool;

    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const wake = () => waiting?.();

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        while (!aborted) {
          if (pending.length === 0) {
            if (ended) return;
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
            continue;
          }

          const userMessage = pending.shift()!;
          yield { type: 'activity' };

          // Tool-call loop: each round is one round-trip with the model.
          // Round 0 sends the user message; subsequent rounds send the
          // collected functionResponse parts back to the model. We stop
          // when the model returns text without any functionCalls or
          // when we hit the safety cap.
          let nextMessage: PartListUnion = userMessage;
          let textAccum = '';
          let round = 0;

          while (round < MAX_TOOL_ROUNDS_PER_TURN) {
            const stream = await chat.sendMessageStream({ message: nextMessage });
            const calls: FunctionCall[] = [];

            for await (const chunk of stream) {
              if (aborted) return;
              yield { type: 'activity' };
              textAccum = appendChunkText(textAccum, chunk);
              if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                calls.push(...chunk.functionCalls);
              }
            }

            if (calls.length === 0) break;

            // Execute every requested tool. Run sequentially so an
            // earlier tool's side effect is visible before a later
            // tool that depends on the same in-process state runs
            // (e.g., set_direction then read_briefing).
            const responseParts: Part[] = [];
            for (const call of calls) {
              if (aborted) return;
              yield { type: 'activity' };
              const part = await executeToolCall(call, resolveTool);
              responseParts.push(part);
            }
            nextMessage = responseParts;
            round += 1;
          }

          if (round >= MAX_TOOL_ROUNDS_PER_TURN) {
            log(`tool-call loop hit cap (${MAX_TOOL_ROUNDS_PER_TURN}) without text result`);
          }

          yield {
            type: 'init',
            continuation: serializeHistory(chat.getHistory(true)),
          };
          yield { type: 'result', text: textAccum || null };
        }
      },
    };

    return {
      push(message: string) {
        pending.push(message);
        wake();
      },
      end() {
        ended = true;
        wake();
      },
      events,
      abort() {
        aborted = true;
        ended = true;
        wake();
      },
    };
  }
}

registerProvider('gemini', (opts) => new GeminiProvider(opts));
