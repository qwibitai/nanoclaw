import fs from 'fs';
import path from 'path';

import { DATA_DIR, CONTAINER_TIMEOUT } from './config.js';
import { logger } from './logger.js';

// DONE and FAILED share value 3: both are terminal states with monotonic
// forward-only transitions (state >= current). The emoji differs but the
// ordering logic treats them identically.
export enum StatusState {
  RECEIVED = 0,
  THINKING = 1,
  WORKING = 2,
  DONE = 3,
  FAILED = 3,
}

const DONE_EMOJI = '\u{2705}';
const FAILED_EMOJI = '\u{274C}';

const CLEANUP_DELAY_MS = 5000;
const RECEIVED_GRACE_MS = 30_000;
const REACTION_MAX_RETRIES = 3;
const REACTION_BASE_DELAY_MS = 2000;

interface MessageKey {
  id: string;
  remoteJid: string;
  fromMe?: boolean;
}

interface TrackedMessage {
  messageId: string;
  chatJid: string;
  fromMe: boolean;
  state: number;
  terminal: 'done' | 'failed' | null;
  sendChain: Promise<void>;
  trackedAt: number;
}

interface PersistedEntry {
  messageId: string;
  chatJid: string;
  fromMe: boolean;
  state: number;
  terminal: 'done' | 'failed' | null;
  trackedAt: number;
}

export interface StatusTrackerDeps {
  sendReaction: (
    chatJid: string,
    messageKey: MessageKey,
    emoji: string,
  ) => Promise<void>;
  sendMessage: (chatJid: string, text: string) => Promise<void>;
  isMainGroup: (chatJid: string) => boolean;
  isContainerAlive: (chatJid: string) => boolean;
}

export class StatusTracker {
  private tracked = new Map<string, TrackedMessage>();
  private deps: StatusTrackerDeps;
  private persistPath: string;
  private _shuttingDown = false;

  constructor(deps: StatusTrackerDeps) {
    this.deps = deps;
    this.persistPath = path.join(DATA_DIR, 'status-tracker.json');
  }

  markReceived(messageId: string, chatJid: string, fromMe: boolean): boolean {
    if (!this.deps.isMainGroup(chatJid)) return false;
    if (this.tracked.has(messageId)) return false;

    const msg: TrackedMessage = {
      messageId,
      chatJid,
      fromMe,
      state: StatusState.RECEIVED,
      terminal: null,
      sendChain: Promise.resolve(),
      trackedAt: Date.now(),
    };

    this.tracked.set(messageId, msg);
    this.enqueueSend(msg, '\u{1F440}');
    this.persist();
    return true;
  }

  markThinking(messageId: string): boolean {
    return this.transition(messageId, StatusState.THINKING, '\u{1F4AD}');
  }

  markWorking(messageId: string): boolean {
    return this.transition(messageId, StatusState.WORKING, '\u{1F504}');
  }

  markDone(messageId: string): boolean {
    return this.transitionTerminal(messageId, 'done', DONE_EMOJI);
  }

  markFailed(messageId: string): boolean {
    return this.transitionTerminal(messageId, 'failed', FAILED_EMOJI);
  }

  markAllDone(chatJid: string): void {
    for (const [id, msg] of this.tracked) {
      if (msg.chatJid === chatJid && msg.terminal === null) {
        this.transitionTerminal(id, 'done', DONE_EMOJI);
      }
    }
  }

  markAllFailed(chatJid: string, errorMessage: string): void {
    let anyFailed = false;
    for (const [id, msg] of this.tracked) {
      if (msg.chatJid === chatJid && msg.terminal === null) {
        this.transitionTerminal(id, 'failed', FAILED_EMOJI);
        anyFailed = true;
      }
    }
    if (anyFailed) {
      this.deps.sendMessage(chatJid, `[system] ${errorMessage}`).catch((err) =>
        logger.error({ chatJid, err }, 'Failed to send status error message'),
      );
    }
  }

  isTracked(messageId: string): boolean {
    return this.tracked.has(messageId);
  }

  /** Wait for all pending reaction sends to complete. */
  async flush(): Promise<void> {
    const chains = Array.from(this.tracked.values()).map((m) => m.sendChain);
    await Promise.allSettled(chains);
  }

  /** Signal shutdown and flush. Prevents new retry sleeps so flush resolves quickly. */
  async shutdown(): Promise<void> {
    this._shuttingDown = true;
    await this.flush();
  }

  /**
   * Startup recovery: read persisted state and mark all non-terminal entries as failed.
   * Call this before the message loop starts.
   */
  async recover(sendErrorMessage: boolean = true): Promise<void> {
    let entries: PersistedEntry[] = [];
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf-8');
        entries = JSON.parse(raw);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to read status tracker persistence file');
      return;
    }

    const orphanedByChat = new Map<string, number>();
    for (const entry of entries) {
      if (entry.terminal !== null) continue;

      // Reconstruct tracked message for the reaction send
      const msg: TrackedMessage = {
        messageId: entry.messageId,
        chatJid: entry.chatJid,
        fromMe: entry.fromMe,
        state: entry.state,
        terminal: null,
        sendChain: Promise.resolve(),
        trackedAt: entry.trackedAt,
      };
      this.tracked.set(entry.messageId, msg);
      this.transitionTerminal(entry.messageId, 'failed', FAILED_EMOJI);
      orphanedByChat.set(entry.chatJid, (orphanedByChat.get(entry.chatJid) || 0) + 1);
    }

    if (sendErrorMessage) {
      for (const [chatJid] of orphanedByChat) {
        this.deps.sendMessage(
          chatJid,
          `[system] Restarted \u{2014} reprocessing your message.`,
        ).catch((err) =>
          logger.error({ chatJid, err }, 'Failed to send recovery message'),
        );
      }
    }

    await this.flush();
    this.clearPersistence();
    logger.info({ recoveredCount: entries.filter((e) => e.terminal === null).length }, 'Status tracker recovery complete');
  }

  /**
   * Heartbeat: check for stale tracked messages where container has died.
   * Call this from the IPC poll cycle.
   */
  heartbeatCheck(): void {
    const now = Date.now();
    for (const [id, msg] of this.tracked) {
      if (msg.terminal !== null) continue;

      // For RECEIVED messages, only fail if container is dead AND grace period elapsed.
      // This closes the gap where a container dies before advancing to THINKING.
      if (msg.state < StatusState.THINKING) {
        if (!this.deps.isContainerAlive(msg.chatJid) && now - msg.trackedAt > RECEIVED_GRACE_MS) {
          logger.warn({ messageId: id, chatJid: msg.chatJid, age: now - msg.trackedAt }, 'Heartbeat: RECEIVED message stuck with dead container');
          this.markAllFailed(msg.chatJid, 'Task crashed \u{2014} retrying.');
          return; // Safe for main-chat-only scope. If expanded to multiple chats, loop instead of return.
        }
        continue;
      }

      if (!this.deps.isContainerAlive(msg.chatJid)) {
        logger.warn({ messageId: id, chatJid: msg.chatJid }, 'Heartbeat: container dead, marking failed');
        this.markAllFailed(msg.chatJid, 'Task crashed \u{2014} retrying.');
        return; // Safe for main-chat-only scope. If expanded to multiple chats, loop instead of return.
      }

      if (now - msg.trackedAt > CONTAINER_TIMEOUT) {
        logger.warn({ messageId: id, chatJid: msg.chatJid, age: now - msg.trackedAt }, 'Heartbeat: message stuck beyond timeout');
        this.markAllFailed(msg.chatJid, 'Task timed out \u{2014} retrying.');
        return; // See above re: single-chat scope.
      }
    }
  }

  private transition(messageId: string, newState: number, emoji: string): boolean {
    const msg = this.tracked.get(messageId);
    if (!msg) return false;
    if (msg.terminal !== null) return false;
    if (newState <= msg.state) return false;

    msg.state = newState;
    // Reset trackedAt on THINKING so heartbeat timeout measures from container start, not message receipt
    if (newState === StatusState.THINKING) {
      msg.trackedAt = Date.now();
    }
    this.enqueueSend(msg, emoji);
    this.persist();
    return true;
  }

  private transitionTerminal(messageId: string, terminal: 'done' | 'failed', emoji: string): boolean {
    const msg = this.tracked.get(messageId);
    if (!msg) return false;
    if (msg.terminal !== null) return false;

    msg.state = StatusState.DONE; // DONE and FAILED both = 3
    msg.terminal = terminal;
    this.enqueueSend(msg, emoji);
    this.persist();
    this.scheduleCleanup(messageId);
    return true;
  }

  private enqueueSend(msg: TrackedMessage, emoji: string): void {
    const key: MessageKey = {
      id: msg.messageId,
      remoteJid: msg.chatJid,
      fromMe: msg.fromMe,
    };
    msg.sendChain = msg.sendChain.then(async () => {
      for (let attempt = 1; attempt <= REACTION_MAX_RETRIES; attempt++) {
        try {
          await this.deps.sendReaction(msg.chatJid, key, emoji);
          return;
        } catch (err) {
          if (attempt === REACTION_MAX_RETRIES) {
            logger.error({ messageId: msg.messageId, emoji, err, attempts: attempt }, 'Failed to send status reaction after retries');
          } else if (this._shuttingDown) {
            logger.warn({ messageId: msg.messageId, emoji, attempt, err }, 'Reaction send failed, skipping retry (shutting down)');
            return;
          } else {
            const delay = REACTION_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            logger.warn({ messageId: msg.messageId, emoji, attempt, delay, err }, 'Reaction send failed, retrying');
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
    });
  }

  /** Must remain async (setTimeout) — synchronous deletion would break iteration in markAllDone/markAllFailed. */
  private scheduleCleanup(messageId: string): void {
    setTimeout(() => {
      this.tracked.delete(messageId);
      this.persist();
    }, CLEANUP_DELAY_MS);
  }

  private persist(): void {
    try {
      const entries: PersistedEntry[] = [];
      for (const msg of this.tracked.values()) {
        entries.push({
          messageId: msg.messageId,
          chatJid: msg.chatJid,
          fromMe: msg.fromMe,
          state: msg.state,
          terminal: msg.terminal,
          trackedAt: msg.trackedAt,
        });
      }
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(entries));
    } catch (err) {
      logger.warn({ err }, 'Failed to persist status tracker state');
    }
  }

  private clearPersistence(): void {
    try {
      fs.writeFileSync(this.persistPath, '[]');
    } catch {
      // ignore
    }
  }
}
