/**
 * Container-side UTI Dashboard telemetry — fire-and-forget event emitter.
 * Standalone module (cannot import host modules from inside a container).
 *
 * Fails silently with a 3s timeout — telemetry never blocks agent execution.
 *
 * Env vars (passed from host via container-runner):
 *   TELEMETRY_API_URL — ingest base URL
 *   TELEMETRY_BOT_ID — this bot's registered UUID
 *   TELEMETRY_REGISTRATION_TOKEN — bearer token for ingest auth
 *   TELEMETRY_KEY_LABEL — active subscription key label (optional, multi-key mode)
 */

const TIMEOUT_MS = 3_000;

const TELEMETRY_URL = (process.env.TELEMETRY_API_URL || '').replace(/\/$/, '');
const BOT_ID = process.env.TELEMETRY_BOT_ID || '';
const TOKEN = process.env.TELEMETRY_REGISTRATION_TOKEN || '';
const KEY_LABEL = process.env.TELEMETRY_KEY_LABEL || '';

const enabled = !!(TELEMETRY_URL && BOT_ID && TOKEN);

if (!enabled) {
  console.error(
    '[container-telemetry] Disabled — missing TELEMETRY_API_URL, TELEMETRY_BOT_ID, or TELEMETRY_REGISTRATION_TOKEN',
  );
}

async function emit(eventType: string, payload: Record<string, unknown>): Promise<void> {
  if (!enabled) return;

  try {
    const response = await fetch(`${TELEMETRY_URL}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        bot_id: BOT_ID,
        event_type: eventType,
        payload,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`[container-telemetry] ${eventType} → HTTP ${response.status}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[container-telemetry] ${eventType} failed: ${msg}`);
  }
}

/** Emit token_usage from an SDK result message */
export function emitTokenUsage(data: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd: number;
  model?: string;
  durationMs?: number;
  numTurns?: number;
}): void {
  emit('token_usage', {
    input_tokens: data.inputTokens,
    output_tokens: data.outputTokens,
    cache_read_input_tokens: data.cacheReadInputTokens ?? 0,
    cache_creation_input_tokens: data.cacheCreationInputTokens ?? 0,
    total_cost_usd: data.totalCostUsd,
    model: data.model,
    duration_ms: data.durationMs,
    num_turns: data.numTurns,
    ...(KEY_LABEL && { key_label: KEY_LABEL }),
  }).catch(() => {});
}

/** Emit tool_call from an SDK tool_use content block or tool_use_summary */
export function emitToolCall(data: {
  toolName: string;
  toolUseId: string;
  parentToolUseId?: string | null;
}): void {
  emit('tool_call', {
    tool_name: data.toolName,
    tool_use_id: data.toolUseId,
    parent_tool_use_id: data.parentToolUseId ?? null,
  }).catch(() => {});
}

export function isTelemetryEnabled(): boolean {
  return enabled;
}
