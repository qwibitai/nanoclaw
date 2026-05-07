/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { registerSecretsFromEnv } from './secret-scrubber.js';
import {
  getMessagingGroupsByChannel,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
} from './db/messaging-groups.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { stopAllContainers } from './container-runner.js';
import {
  getDeliveryAdapter,
  setDeliveryAdapter,
  startActiveDeliveryPoll,
  startSweepDeliveryPoll,
  stopDeliveryPolls,
} from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { startWorktreeCleanup, stopWorktreeCleanup } from './worktree-cleanup.js';
import { startPluginUpdater, stopPluginUpdater } from './plugin-updater.js';
import { startCommitScan, stopCommitScan } from './commit-scan.js';
import { restoreRemoteControl } from './remote-control.js';
import { startDiscordSlashCommands, stopDiscordSlashCommands } from './channels/discord-slash-commands.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import { runStartupOllamaCheck } from './host-ollama-status.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

/**
 * Load .env file values into process.env, without overriding vars already set.
 * Mirrors V1's readEnvFile behavior — needed so ANTHROPIC_BASE_URL,
 * ANTHROPIC_API_KEY, and other env-driven config flows work even when
 * the host is started without those vars in the shell environment.
 */
function loadEnvIntoProcess(): void {
  const envPath = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return; // .env not present — fine
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key && !Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 0a. Load .env into process.env (for secrets not injected by the shell,
  //     like ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY which determine whether
  //     we use direct proxy or OneCLI gateway). Does NOT override vars already
  //     in the process environment — shell-set values take precedence.
  loadEnvIntoProcess();

  // 0b. Register secret values from .env for outbound scrubbing.
  registerSecretsFromEnv();

  // 0c. Non-blocking Ollama startup check — writes data/.host-ollama-status.json.
  runStartupOllamaCheck()
    .then((s) => {
      log.info('host-ollama-status', { ok: s.ok, endpoint: s.endpoint, error: s.error });
    })
    .catch(() => {
      /* never throws */
    });

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          isDM: message.isDM,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        const mg = getMessagingGroupByPlatform(adapter.channelType, platformId);
        if (!mg) return; // router hasn't auto-created it yet — next inbound will
        const updates: Parameters<typeof updateMessagingGroup>[1] = {};
        if (name && mg.name !== name) updates.name = name;
        if (isGroup !== undefined) {
          const isGroupFlag = isGroup ? 1 : 0;
          if (mg.is_group !== isGroupFlag) updates.is_group = isGroupFlag;
        }
        if (Object.keys(updates).length === 0) return;
        updateMessagingGroup(mg.id, updates);
        log.info('Channel metadata persisted', {
          channelType: adapter.channelType,
          platformId,
          mgId: mg.id,
          updates,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
    async deleteMessage(
      channelType: string,
      platformId: string,
      threadId: string | null,
      messageId: string,
    ): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.deleteMessage?.(platformId, threadId, messageId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7. Start worktree cleanup cron (6h, first run 60s after startup)
  startWorktreeCleanup();
  log.info('Worktree cleanup started');

  // 8. Start plugin auto-updater (hourly, first run 5min after startup)
  startPluginUpdater({
    notify: async (platformId, text) => {
      // Parse the jid format: <channel_type>:<platform_id>[:<thread_id>]
      const parts = platformId.split(':');
      if (parts.length < 2) {
        log.warn('Plugin updater notify: malformed jid', { platformId });
        return;
      }
      const channelType = parts[0];
      const realPlatformId = parts.slice(1).join(':');
      const adapter = getDeliveryAdapter();
      if (!adapter) {
        log.warn('Plugin updater notify: no delivery adapter yet', { platformId });
        return;
      }
      await adapter.deliver(channelType, realPlatformId, null, 'chat', JSON.stringify({ text }));
    },
  });
  log.info('Plugin updater started');

  // 9. Start commit-digest scanner (10min interval, first run 90s after
  //    startup) — records direct commits + external PRs to default branch
  //    as ship_log entries, complementing the agent-driven add_ship_log.
  startCommitScan();
  log.info('Commit scan started');

  // 10. Restore any Remote Control session that was running before restart
  restoreRemoteControl();

  // 10. Start Discord slash-command client (gated on
  //     ENABLE_DISCORD_SLASH_COMMANDS=1).
  startDiscordSlashCommands().catch((err) => {
    log.error('Discord slash commands failed to start', { err });
  });

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  stopWorktreeCleanup();
  stopPluginUpdater();
  stopCommitScan();
  await stopDiscordSlashCommands();
  try {
    await teardownChannelAdapters();
    // Synchronously stop agent containers before exit. Without this, child
    // subprocesses linger in the cgroup and systemd TimeoutStopSec stalls
    // every restart. Matches v1's GroupQueue.shutdown semantics.
    try {
      await stopAllContainers();
    } catch (err) {
      log.error('stopAllContainers threw', { err });
    }
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
