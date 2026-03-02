/**
 * Event-driven reactions for NanoClaw lifecycle events.
 *
 * Migrated from inline code in index.ts to decouple reactions from the
 * orchestration flow. Each listener is independently registered and
 * can be disabled without affecting the rest of the system.
 */
import { IDLE_TIMEOUT } from './config.js';
import { EventBus } from './event-bus.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { Channel } from './types.js';

export interface ListenerDeps {
  bus: EventBus;
  queue: GroupQueue;
  channels: Channel[];
  findChannel: (channels: Channel[], jid: string) => Channel | undefined;
  sessions: Record<string, string>;
  deleteSession: (groupFolder: string) => void;
}

/**
 * Register all event-driven reactions.
 * Call once during startup after the bus and all deps are initialized.
 */
export function registerEventListeners(deps: ListenerDeps): void {
  registerSessionClearingOnError(deps);
  registerTypingIndicator(deps);
  registerIdleTimeout(deps);
}

// ---------------------------------------------------------------------------
// 1. Session clearing on agent error
// ---------------------------------------------------------------------------

function registerSessionClearingOnError(deps: ListenerDeps): void {
  deps.bus.on('agent:completed', (event) => {
    if (event.status !== 'error') return;

    delete deps.sessions[event.groupFolder];
    deps.deleteSession(event.groupFolder);

    deps.bus.emit('session:cleared', {
      timestamp: new Date().toISOString(),
      groupFolder: event.groupFolder,
      reason: 'agent-error',
    });

    logger.debug(
      { groupFolder: event.groupFolder },
      'Session cleared via event listener (agent error)',
    );
  });
}

// ---------------------------------------------------------------------------
// 2. Typing indicator
// ---------------------------------------------------------------------------

function registerTypingIndicator(deps: ListenerDeps): void {
  deps.bus.on('agent:invoked', (event) => {
    const channel = deps.findChannel(deps.channels, event.chatJid);
    channel?.setTyping?.(event.chatJid, true);
  });

  deps.bus.on('agent:completed', (event) => {
    const channel = deps.findChannel(deps.channels, event.chatJid);
    channel?.setTyping?.(event.chatJid, false);
  });
}

// ---------------------------------------------------------------------------
// 3. Idle timeout (close container stdin when agent is idle)
// ---------------------------------------------------------------------------

function registerIdleTimeout(deps: ListenerDeps): void {
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  deps.bus.on('container:output', (event) => {
    // Only reset idle timer on actual results, not session-update markers
    if (event.result === null) return;

    const existing = idleTimers.get(event.chatJid);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      logger.debug(
        { groupFolder: event.groupFolder },
        'Idle timeout, closing container stdin (event-driven)',
      );
      deps.queue.closeStdin(event.chatJid);
      idleTimers.delete(event.chatJid);
    }, IDLE_TIMEOUT);

    idleTimers.set(event.chatJid, timer);
  });

  deps.bus.on('agent:completed', (event) => {
    const timer = idleTimers.get(event.chatJid);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(event.chatJid);
    }
  });
}
