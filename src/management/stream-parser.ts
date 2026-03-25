// src/management/stream-parser.ts

export interface StreamEvent {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Parse a single line of Claude's stream-json output into management events.
 *
 * Claude Code --output-format stream-json emits one JSON object per line:
 *   {"type":"system", ...}           — init/session info, ignored
 *   {"type":"assistant","message":{  — agent turn with content blocks
 *     "content":[
 *       {"type":"text","text":"..."}              → chat.delta
 *       {"type":"tool_use","name":"...","input":{}} → agent.tool
 *     ]
 *   }}
 *   {"type":"result","subtype":"success","result":"...","usage":{...}} → chat.final
 */
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

  if (parsed.type === 'assistant') {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = (message?.content ?? []) as Array<Record<string, unknown>>;
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        events.push({
          event: 'chat.delta',
          payload: { sessionKey, runId, content: block.text },
        });
      } else if (block.type === 'tool_use') {
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
  } else if (parsed.type === 'result') {
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
