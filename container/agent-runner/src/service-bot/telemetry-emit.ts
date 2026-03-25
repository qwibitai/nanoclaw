// Telemetry emission — sends service_action events to the UTI telemetry service.

import { getBotConfig } from './config.js';

export interface ServiceAction {
  targetBot: string; // bot name (e.g. "db", "nook")
  action: string; // e.g. "restart", "config_edit", "log_review", "health_check"
  trigger: 'ticket' | 'watcher' | 'manual';
  ticketRef?: string; // GitHub Issue URL if applicable
  result: 'success' | 'failed';
  summary: string;
}

const TELEMETRY_TIMEOUT_MS = 3000;

/**
 * Resolve a bot name to its UTI telemetry bot_id.
 * Returns undefined if the bot has no telemetryBotId configured.
 */
function resolveTargetBotId(botName: string): string | undefined {
  try {
    const config = getBotConfig(botName);
    return config.telemetryBotId;
  } catch {
    return undefined;
  }
}

/**
 * Emit a service_action event to the telemetry service.
 * Fails silently (logs warning) — telemetry should never block bot actions.
 */
export async function emitServiceAction(action: ServiceAction): Promise<void> {
  const telemetryUrl = process.env.TELEMETRY_URL;
  const token = process.env.TELEMETRY_REGISTRATION_TOKEN;
  const botId = process.env.TELEMETRY_BOT_ID;

  if (!telemetryUrl || !token || !botId) {
    console.warn(
      '[telemetry] Missing env vars (TELEMETRY_URL, TELEMETRY_REGISTRATION_TOKEN, or TELEMETRY_BOT_ID). Skipping emit.',
    );
    return;
  }

  const targetBotId = resolveTargetBotId(action.targetBot);
  if (!targetBotId) {
    console.warn(
      `[telemetry] No telemetryBotId configured for bot "${action.targetBot}". Skipping emit.`,
    );
    return;
  }

  const event = {
    timestamp: new Date().toISOString(),
    bot_id: botId,
    event_type: 'service_action',
    payload: {
      target_bot_id: targetBotId,
      action: action.action,
      trigger: action.trigger,
      ticket_ref: action.ticketRef,
      result: action.result,
      summary: action.summary,
    },
  };

  try {
    const response = await fetch(`${telemetryUrl}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(
        `[telemetry] Ingest returned HTTP ${response.status}: ${response.statusText}`,
      );
    }
  } catch (err: any) {
    console.warn(`[telemetry] Failed to emit service_action: ${err.message}`);
  }
}
