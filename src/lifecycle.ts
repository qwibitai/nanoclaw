import fs from 'fs';
import path from 'path';

import { CREDENTIAL_PROXY_PORT, GROUPS_DIR } from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import { initSecrets } from './env.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { writeGroupsSnapshot } from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { buildServiceHealthSnapshot } from './service-health.js';

import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  storeChatMetadata,
  storeMessage,
} from './db/index.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startHostExecWatcher, stopHostExecWatcher } from './host-exec.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { initSkillRegistry, shutdownSkillRegistry } from './skill-registry.js';
import {
  startDispatchLoop,
  startSprintRetroWatcherSubsystem,
  startStallDetector,
  stopAgencyHqSubsystems,
} from './agency-hq-dispatcher.js';
import { setSubsystemState } from './subsystem-status.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { startUptimeMonitor, stopUptimeMonitor } from './uptime-monitor.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { connectWithBackoff } from './circuit-breaker.js';
import type { AvailableGroup } from './container-runner.js';

// --- Shared mutable state ---

export const state = {
  lastTimestamp: '',
  sessions: {} as Record<string, string>,
  registeredGroups: {} as Record<string, RegisteredGroup>,
  lastAgentTimestamp: {} as Record<string, string>,
};

export const channels: Channel[] = [];
export const queue = new GroupQueue();

// --- State persistence ---

export function loadState(): void {
  state.lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    state.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    state.lastAgentTimestamp = {};
  }
  state.sessions = getAllSessions();
  state.registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(state.registeredGroups).length },
    'State loaded',
  );
}

export function saveState(): void {
  setRouterState('last_timestamp', state.lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(state.lastAgentTimestamp),
  );
}

// --- Group management ---

export function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  state.registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(state.registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  state.registeredGroups = groups;
}

// --- Startup / Shutdown ---

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/**
 * Initialize the application: database, channels, subsystems, signal handlers.
 * Returns once everything is ready for the message loop.
 */
export async function initApp(): Promise<void> {
  await initSecrets();
  ensureContainerSystemRunning();

  // Ensure global shared context directory exists (groups/global/CLAUDE.md)
  fs.mkdirSync(path.join(GROUPS_DIR, 'global'), { recursive: true });

  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );
  setSubsystemState('credential-proxy', {
    state: 'running',
    details: `Listening on ${PROXY_BIND_HOST}:${CREDENTIAL_PROXY_PORT}.`,
  });

  // Start skill registry (scans container/skills/, watches for changes, serves GET /skills)
  const skillServer = await initSkillRegistry(undefined, {
    healthProvider: () =>
      buildServiceHealthSnapshot(channels, state.registeredGroups),
  });
  setSubsystemState('skill-registry', {
    state: 'running',
    details: 'Serving /skills and /health.',
  });

  // Graceful shutdown handlers
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
    try {
      shutdownSkillRegistry();
      setSubsystemState('skill-registry', {
        state: 'disabled',
        details: 'Shutdown requested.',
      });
      proxyServer.close();
      setSubsystemState('credential-proxy', {
        state: 'disabled',
        details: 'Shutdown requested.',
      });
      if (skillServer) skillServer.close();
      stopUptimeMonitor();
      setSubsystemState('uptime-monitor', {
        state: 'disabled',
        details: 'Shutdown requested.',
      });
      await stopAgencyHqSubsystems();
      setSubsystemState('agency-dispatch', {
        state: 'disabled',
        details: 'Shutdown requested.',
      });
      setSubsystemState('stall-detector', {
        state: 'disabled',
        details: 'Shutdown requested.',
      });
      stopHostExecWatcher();
      setSubsystemState('host-exec', {
        state: 'disabled',
        details: 'Shutdown requested.',
      });
      await queue.shutdown(10000);
      setSubsystemState('scheduler', {
        state: 'disabled',
        details: 'Shutdown requested.',
      });
      setSubsystemState('ipc', {
        state: 'disabled',
        details: 'Shutdown requested.',
      });
      for (const ch of channels) await ch.disconnect();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown cleanup');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = state.registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        state.registeredGroups[chatJid]
      ) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => state.registeredGroups,
  };

  // Create and connect all registered channels with circuit breaker.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);

    const connected = await connectWithBackoff(channelName, () =>
      channel.connect(),
    );
    if (!connected) {
      logger.warn(
        { channel: channelName },
        'Channel failed to connect after retries — circuit breaker tripped',
      );
    }
  }

  const connectedCount = channels.filter((ch) => ch.isConnected()).length;
  if (connectedCount === 0 && channels.length > 0) {
    logger.fatal('No channels connected — all circuit breakers tripped');
    process.exit(1);
  }
  if (channels.length === 0) {
    logger.fatal('No channels configured');
    process.exit(1);
  }

  // Start subsystems
  const schedulerDeps = {
    registeredGroups: () => state.registeredGroups,
    getSessions: () => state.sessions,
    queue,
    onProcess: (
      groupJid: string,
      _proc: unknown,
      sessionName: string,
      groupFolder: string,
    ) => queue.registerProcess(groupJid, _proc, sessionName, groupFolder),
    sendMessage: async (jid: string, rawText: string) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  };
  startSchedulerLoop(schedulerDeps);
  setSubsystemState('scheduler', {
    state: 'running',
    details: 'Scheduled task polling active.',
  });
  try {
    await startDispatchLoop(schedulerDeps);
    setSubsystemState('agency-dispatch', {
      state: 'running',
      details: 'Agency HQ dispatch loop active.',
    });
  } catch (err) {
    setSubsystemState('agency-dispatch', {
      state: 'degraded',
      details: err instanceof Error ? err.message : 'Failed to start.',
    });
    logger.error({ err }, 'Failed to start dispatch loop');
  }
  try {
    await startStallDetector(schedulerDeps);
    setSubsystemState('stall-detector', {
      state: 'running',
      details: 'Agency HQ stall detector active.',
    });
  } catch (err) {
    setSubsystemState('stall-detector', {
      state: 'degraded',
      details: err instanceof Error ? err.message : 'Failed to start.',
    });
    logger.error({ err }, 'Failed to start stall detector');
  }
  startSprintRetroWatcherSubsystem(schedulerDeps).catch((err) =>
    logger.error({ err }, 'Failed to start sprint retro watcher'),
  );
  setSubsystemState('sprint-retro-watcher', {
    state: 'running',
    details: 'Polling hourly; sends messages only on sprint status changes.',
  });
  startUptimeMonitor({
    registeredGroups: () => state.registeredGroups,
    sendMessage: schedulerDeps.sendMessage,
  });
  setSubsystemState('uptime-monitor', {
    state: 'running',
    details: 'User-service failure alerts enabled.',
  });
  startHostExecWatcher();
  setSubsystemState('host-exec', {
    state: 'running',
    details: 'Allowlisted host command watcher active.',
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => state.registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  setSubsystemState('ipc', {
    state: 'running',
    details: 'Filesystem IPC watcher active.',
  });
}
