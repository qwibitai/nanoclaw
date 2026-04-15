/**
 * Translates between Anthropic Messages API format and OpenAI Chat Completions format.
 * Used by the credential proxy when ANTHROPIC_BASE_URL points to an OpenAI-compatible endpoint.
 */

// --- Request translation: Anthropic → OpenAI ---

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  max_tokens: number;
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string };
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export function translateRequest(
  anthropicBody: string,
  modelOverride?: string,
): {
  openaiBody: string;
  originalModel: string;
} {
  const req: AnthropicRequest = JSON.parse(anthropicBody);
  const originalModel = req.model;
  if (modelOverride) req.model = modelOverride;

  const messages: OpenAIMessage[] = [];

  // System prompt
  if (req.system) {
    const systemText =
      typeof req.system === 'string'
        ? req.system
        : req.system.map((s) => s.text).join('\n\n');
    messages.push({ role: 'system', content: systemText });
  }

  // Convert messages
  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Array content blocks
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    const toolResults: { tool_call_id: string; content: string }[] = [];

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const resultContent =
          typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .filter((c) => c.type === 'text')
                  .map((c) => c.text)
                  .join('\n')
              : '';
        toolResults.push({
          tool_call_id: block.tool_use_id,
          content: resultContent,
        });
      }
    }

    if (toolCalls.length > 0) {
      // Assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null,
        tool_calls: toolCalls,
      });
    } else if (toolResults.length > 0) {
      // Tool results become separate tool messages
      for (const result of toolResults) {
        messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: result.tool_call_id,
        });
      }
      // If there's also text alongside tool results, add as user message
      if (textParts.length > 0) {
        messages.push({ role: 'user', content: textParts.join('\n') });
      }
    } else {
      messages.push({
        role: msg.role,
        content: textParts.join('\n') || '',
      });
    }
  }

  // Convert tools
  const tools: OpenAITool[] | undefined = req.tools?.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: cleanSchema(t.input_schema),
    },
  }));

  // Build OpenAI request
  const openaiReq: Record<string, unknown> = {
    model: req.model,
    messages,
    max_completion_tokens: req.max_tokens,
    stream: req.stream ?? false,
  };
  if (tools && tools.length > 0) openaiReq.tools = tools;
  if (req.temperature !== undefined) openaiReq.temperature = req.temperature;
  if (req.top_p !== undefined) openaiReq.top_p = req.top_p;
  if (req.stop_sequences) openaiReq.stop = req.stop_sequences;
  if (req.tool_choice) {
    if (req.tool_choice.type === 'auto') openaiReq.tool_choice = 'auto';
    else if (req.tool_choice.type === 'any') openaiReq.tool_choice = 'required';
    else if (req.tool_choice.type === 'tool' && req.tool_choice.name)
      openaiReq.tool_choice = {
        type: 'function',
        function: { name: req.tool_choice.name },
      };
  }
  if (req.stream) {
    openaiReq.stream_options = { include_usage: true };
  }

  return {
    openaiBody: JSON.stringify(openaiReq),
    originalModel,
  };
}

// Remove unsupported schema properties that strict OpenAI function calling rejects
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

// --- Response translation: OpenAI → Anthropic (non-streaming JSON) ---

export function translateResponse(
  openaiBody: string,
  originalModel: string,
): string {
  const resp = JSON.parse(openaiBody);
  const choice = resp.choices?.[0];
  if (!choice) {
    return JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'No response from model.' }],
      model: originalModel,
      stop_reason: 'end_turn',
      usage: {
        input_tokens: resp.usage?.prompt_tokens || 0,
        output_tokens: resp.usage?.completion_tokens || 0,
      },
    });
  }

  const content: AnthropicContentBlock[] = [];

  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: safeParseJSON(tc.function.arguments),
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const stopReason =
    choice.finish_reason === 'tool_calls'
      ? 'tool_use'
      : choice.finish_reason === 'length'
        ? 'max_tokens'
        : 'end_turn';

  return JSON.stringify({
    id: resp.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: originalModel,
    stop_reason: stopReason,
    usage: {
      input_tokens: resp.usage?.prompt_tokens || 0,
      output_tokens: resp.usage?.completion_tokens || 0,
    },
  });
}

// --- SSE streaming translation: OpenAI → Anthropic ---

export function translateSSEChunk(
  openaiLine: string,
  state: StreamState,
): string[] {
  if (!openaiLine.startsWith('data: ')) return [];
  const jsonStr = openaiLine.slice(6).trim();
  if (jsonStr === '[DONE]') {
    // Emit message_delta with final usage and message_stop
    const events: string[] = [];
    events.push(
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: state.stopReason || 'end_turn' },
        usage: { output_tokens: state.outputTokens },
      })}\n`,
    );
    events.push(
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n`,
    );
    return events;
  }

  try {
    const chunk = JSON.parse(jsonStr);
    const events: string[] = [];

    // Usage in final chunk
    if (chunk.usage) {
      state.inputTokens = chunk.usage.prompt_tokens || state.inputTokens;
      state.outputTokens = chunk.usage.completion_tokens || state.outputTokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return events;

    const delta = choice.delta;
    if (!delta) return events;

    // Track finish reason
    if (choice.finish_reason) {
      state.stopReason =
        choice.finish_reason === 'tool_calls'
          ? 'tool_use'
          : choice.finish_reason === 'length'
            ? 'max_tokens'
            : 'end_turn';
    }

    // First chunk: emit message_start
    if (!state.started) {
      state.started = true;
      events.push(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: chunk.id || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: state.model,
            stop_reason: null,
            usage: {
              input_tokens: state.inputTokens,
              output_tokens: 0,
            },
          },
        })}\n`,
      );
    }

    // Text content
    if (delta.content) {
      if (!state.inTextBlock) {
        state.inTextBlock = true;
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: state.blockIndex,
            content_block: { type: 'text', text: '' },
          })}\n`,
        );
      }
      events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: state.blockIndex,
          delta: { type: 'text_delta', text: delta.content },
        })}\n`,
      );
    }

    // Tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0;

        // Close text block if open
        if (state.inTextBlock) {
          events.push(
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: state.blockIndex,
            })}\n`,
          );
          state.blockIndex++;
          state.inTextBlock = false;
        }

        if (tc.id) {
          // New tool call start
          state.toolCalls[tcIndex] = {
            id: tc.id,
            name: tc.function?.name || '',
            args: '',
          };
          events.push(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: state.blockIndex + tcIndex,
              content_block: {
                type: 'tool_use',
                id: tc.id,
                name: tc.function?.name || '',
                input: {},
              },
            })}\n`,
          );
        }

        if (tc.function?.arguments) {
          state.toolCalls[tcIndex] = state.toolCalls[tcIndex] || {
            id: '',
            name: '',
            args: '',
          };
          state.toolCalls[tcIndex].args += tc.function.arguments;
          events.push(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: state.blockIndex + tcIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: tc.function.arguments,
              },
            })}\n`,
          );
        }
      }
    }

    // Close blocks on finish
    if (choice.finish_reason) {
      if (state.inTextBlock) {
        events.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: state.blockIndex,
          })}\n`,
        );
        state.inTextBlock = false;
      }
      for (const tcIndex of Object.keys(state.toolCalls)) {
        events.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: state.blockIndex + parseInt(tcIndex),
          })}\n`,
        );
      }
    }

    return events;
  } catch {
    return [];
  }
}

export interface StreamState {
  started: boolean;
  model: string;
  blockIndex: number;
  inTextBlock: boolean;
  toolCalls: Record<number, { id: string; name: string; args: string }>;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export function createStreamState(model: string): StreamState {
  return {
    started: false,
    model,
    blockIndex: 0,
    inTextBlock: false,
    toolCalls: {},
    inputTokens: 0,
    outputTokens: 0,
    stopReason: null,
  };
}

function safeParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
