import type { AgentRunner } from './agent-runner.js';
import type { ChannelStatusReporter } from './channel-status.js';
import type { GroupsSyncHandler } from './groups-sync.js';
import type { WhatsAppPairingRelay } from './whatsapp-relay.js';

// Maps sessionKey → the runId of its most recent chat.send.
// Exported so paas-entrypoint can tag streamed output events with the correct runId.
export const sessionRunIds = new Map<string, string>();
const startTime = Date.now();

export interface HandlerDeps {
  channelStatusReporter?: ChannelStatusReporter;
  whatsAppRelay?: WhatsAppPairingRelay;
  groupsSyncHandler?: GroupsSyncHandler;
}

export function createHandlers(
  runner: AgentRunner,
  pushEvent?: (event: string, payload: Record<string, unknown>) => void,
  deps?: HandlerDeps | ChannelStatusReporter,
): Record<string, (params: any) => Promise<any>> {
  // Support legacy call-site that passes ChannelStatusReporter directly
  const resolved: HandlerDeps =
    deps && 'getStatus' in deps
      ? { channelStatusReporter: deps as ChannelStatusReporter }
      : ((deps as HandlerDeps) ?? {});
  const { channelStatusReporter, whatsAppRelay, groupsSyncHandler } = resolved;
  return {
    health: async () => ({
      status: 'ok' as const,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeAgents: runner.activeCount,
    }),

    'chat.send': async (params: {
      sessionKey: string;
      message: string;
      resumeSessionId?: string;
    }) => {
      const runId = crypto.randomUUID();
      sessionRunIds.set(params.sessionKey, runId);

      // With `-p`, claude processes one prompt and exits. Each chat.send spawns
      // a fresh process. Kill any existing session for this key first.
      if (runner.getSession(params.sessionKey)) {
        await runner.kill(params.sessionKey);
      }

      try {
        await runner.spawn({
          sessionKey: params.sessionKey,
          model: process.env.MODEL_PRIMARY || 'claude-sonnet-4-20250514',
          systemPrompt: process.env.SYSTEM_PROMPT || '',
          initialPrompt: params.message,
          resumeSessionId: params.resumeSessionId,
        });
      } catch (err: unknown) {
        // Pre-flight failures (missing API key, max concurrency) surface as
        // chat.error events so the frontend gets actionable feedback.
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[chat.send:${params.sessionKey}] Spawn failed: ${message}`,
        );
        pushEvent?.('chat.error', {
          sessionKey: params.sessionKey,
          runId,
          error: message,
        });
      }

      return { runId, sessionKey: params.sessionKey };
    },

    'chat.abort': async (params: { sessionKey: string }) => {
      sessionRunIds.delete(params.sessionKey);
      await runner.kill(params.sessionKey);
      return { aborted: true };
    },

    'sessions.list': async () => [],

    'chat.history': async () => [],

    'channels.status': async () => {
      if (!channelStatusReporter) {
        return { channels: [] };
      }
      return channelStatusReporter.getStatus();
    },

    'whatsapp.pair': async () => {
      if (!whatsAppRelay) {
        throw new Error('WhatsApp pairing relay not configured');
      }
      return whatsAppRelay.initiatePairing();
    },

    'groups.sync': async (params: any) => {
      if (!groupsSyncHandler) {
        throw new Error('Groups sync handler not configured');
      }
      return groupsSyncHandler.sync(params);
    },

    'groups.list': async () => {
      if (!groupsSyncHandler) {
        throw new Error('Groups sync handler not configured');
      }
      return groupsSyncHandler.list();
    },
  };
}
