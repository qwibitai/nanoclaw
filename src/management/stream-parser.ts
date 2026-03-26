// src/management/stream-parser.ts

export interface StreamEvent {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Parse a single line of Claude's stream-json output into management events.
 *
 * With --include-partial-messages, stream-json emits three relevant line types:
 *
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 *     → chat.delta  (real-time per-token text streaming)
 *
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."},{"type":"tool_use",...}]}}
 *     → agent.tool  (tool use blocks; text blocks are ignored here since
 *       stream_event deltas already delivered the text incrementally)
 *
 *   {"type":"result","subtype":"success","result":"...","usage":{...}}
 *     → chat.final  (response complete with usage stats)
 */

export function resetStreamState(_sessionKey: string): void {
  // No per-session state needed — stream_event text_deltas are true deltas.
}

export function parseStreamJsonLine(
  line: string,
  sessionKey: string,
  runId: string,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return events;
  }

  // ── stream_event: real-time deltas from the API ──────────────────────
  if (parsed.type === 'stream_event') {
    const ev = parsed.event as Record<string, unknown> | undefined;
    if (!ev) return events;

    if (ev.type === 'content_block_delta') {
      const delta = ev.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && delta.text) {
        events.push({
          event: 'chat.delta',
          payload: { sessionKey, runId, content: delta.text as string },
        });
      }
      // thinking_delta, signature_delta, etc. are ignored.
    }
    // content_block_start, content_block_stop, message_start, message_stop,
    // message_delta are all ignored — we only need text deltas and the
    // final "result" line for completion.
    return events;
  }

  // ── assistant: cumulative message snapshot ────────────────────────────
  // With --include-partial-messages we get text via stream_event deltas,
  // so we only extract tool_use blocks from assistant messages.
  if (parsed.type === 'assistant') {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = (message?.content ?? []) as Array<Record<string, unknown>>;
    for (const block of content) {
      if (block.type === 'tool_use') {
        events.push({
          event: 'agent.tool',
          payload: {
            sessionKey,
            runId,
            tool: (block.name as string) || '',
            input: block.input,
            output: null,
          },
        });
      }
    }
    return events;
  }

  // ── result: final response with usage ────────────────────────────────
  if (parsed.type === 'result') {
    const usage = parsed.usage as Record<string, number> | undefined;
    events.push({
      event: 'chat.final',
      payload: {
        sessionKey,
        runId,
        content: (parsed.result as string) || '',
        ...(parsed.session_id ? { sessionId: parsed.session_id } : {}),
        usage: {
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
        },
      },
    });
  }

  return events;
}
