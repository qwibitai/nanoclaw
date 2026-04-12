import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const FOREVER = 0x7fffffff; // Telegram "unlimited" live_period value
const MAX_LOG_SIZE = 1024 * 1024; // 1 MiB
const MAX_BACKUPS = 5;
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface LiveLocationEntry {
  time: string; // ISO-8601
  lat: number;
  lng: number;
  horizontal_accuracy?: number; // omitted if absent
  heading?: number; // omitted if absent
}

export interface LiveSession {
  chatJid: string;
  messageId: number;
  logFilePath: string;
  latestLat: number;
  latestLng: number;
  latestHorizontalAccuracy?: number;
  latestHeading?: number;
  livePeriod: number;
  isRecovery: boolean;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export interface LiveLocationManagerOpts {
  logDir: string;
  idleTimeoutMs: number;
  onTimeout: (chatJid: string) => void;
  onStopped: (chatJid: string) => void;
}

// ---------------------------------------------------------------------------
// Standalone pure helpers (exported for testing and cross-module use)
// ---------------------------------------------------------------------------

export function buildLocationPrefix(
  label: '[Live location sharing start]' | '[Live location sharing enabled]',
  lat: number,
  lng: number,
  logFilePath: string,
  horizontalAccuracy?: number,
  heading?: number,
): string {
  const parts = [`lat: ${lat}`, `long: ${lng}`];
  if (horizontalAccuracy !== undefined)
    parts.push(`horizontal_accuracy: ${horizontalAccuracy}`);
  if (heading !== undefined) parts.push(`heading: ${heading}`);
  return `${label} ${parts.join(', ')}. check \`tail ${logFilePath}\``;
}

// ---------------------------------------------------------------------------
// Module-level accessor — allows task-scheduler.ts to query without going
// through index.ts / SchedulerDependencies.
// ---------------------------------------------------------------------------

let _activeManager: LiveLocationManager | null = null;

/** @internal Called by TelegramChannel on connect/disconnect. */
export function _setActiveLiveLocationManager(
  m: LiveLocationManager | null,
): void {
  _activeManager = m;
}

/** Returns the live location context prefix for chatJid, or '' if no session. */
export function getActiveLiveLocationContext(chatJid: string): string {
  const pos = _activeManager?.getLatestPosition(chatJid);
  if (!pos) return '';
  return (
    buildLocationPrefix(
      '[Live location sharing enabled]',
      pos.latestLat,
      pos.latestLng,
      pos.logFilePath,
      pos.latestHorizontalAccuracy,
      pos.latestHeading,
    ) + '\n'
  );
}

// ---------------------------------------------------------------------------
// LiveLocationManager
// ---------------------------------------------------------------------------

export class LiveLocationManager {
  private sessions = new Map<string, LiveSession>();
  private cleanupHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: LiveLocationManagerOpts) {}

  /** Run once at channel connect: create dir, initial cleanup, schedule hourly cleanup. */
  initialize(): void {
    fs.mkdirSync(this.opts.logDir, { recursive: true });
    this.cleanupOldLogs();
    this.cleanupHandle = setInterval(
      () => this.cleanupOldLogs(),
      CLEANUP_INTERVAL_MS,
    );
  }

  destroy(): void {
    if (this.cleanupHandle !== null) {
      clearInterval(this.cleanupHandle);
      this.cleanupHandle = null;
    }
    for (const session of this.sessions.values()) {
      clearTimeout(session.timeoutHandle);
    }
    this.sessions.clear();
  }

  /**
   * Start a new live location session. Replaces any existing session for
   * this chatJid (clears its timer). Returns the absolute log file path.
   */
  startSession(
    chatJid: string,
    messageId: number,
    lat: number,
    lng: number,
    livePeriod: number,
    horizontalAccuracy?: number,
    heading?: number,
  ): string {
    // Cancel any existing session for this chat
    const existing = this.sessions.get(chatJid);
    if (existing) clearTimeout(existing.timeoutHandle);

    const logFilePath = this.makeLogFilePath(chatJid, messageId);
    const entry = this.makeEntry(lat, lng, horizontalAccuracy, heading);
    this.appendLogEntry(logFilePath, entry);

    const timeoutHandle = this.scheduleTimeout(chatJid, livePeriod, false);
    const session: LiveSession = {
      chatJid,
      messageId,
      logFilePath,
      latestLat: lat,
      latestLng: lng,
      latestHorizontalAccuracy: horizontalAccuracy,
      latestHeading: heading,
      livePeriod,
      isRecovery: false,
      timeoutHandle,
    };
    this.sessions.set(chatJid, session);
    return logFilePath;
  }

  /**
   * Handle an edited_message:location update.
   * Returns:
   *   'updated'          — normal append, timer reset
   *   'stopped'          — live_period === 0 (user stopped); caller must call stopSession
   *   'recovery-created' — no session but log file existed; recovery session created
   */
  updateSession(
    chatJid: string,
    messageId: number,
    lat: number,
    lng: number,
    horizontalAccuracy?: number,
    heading?: number,
    incomingLivePeriod?: number,
  ): 'updated' | 'stopped' | 'recovery-created' {
    const entry = this.makeEntry(lat, lng, horizontalAccuracy, heading);
    const session = this.sessions.get(chatJid);

    if (session) {
      // Always append the entry (even for stop events — log final position)
      this.appendLogEntry(session.logFilePath, entry);

      if (incomingLivePeriod === 0) {
        clearTimeout(session.timeoutHandle);
        return 'stopped';
      }

      // Normal update: refresh position and reset idle timeout
      session.latestLat = lat;
      session.latestLng = lng;
      session.latestHorizontalAccuracy = horizontalAccuracy;
      session.latestHeading = heading;
      clearTimeout(session.timeoutHandle);
      session.timeoutHandle = this.scheduleTimeout(
        chatJid,
        session.livePeriod,
        session.isRecovery,
      );
      return 'updated';
    }

    // No active session — check for restart recovery
    const logFilePath = this.makeLogFilePath(chatJid, messageId);
    if (fs.existsSync(logFilePath)) {
      this.appendLogEntry(logFilePath, entry);

      // Recovery: use FOREVER timeout; do NOT fire onTimeout (agent was never notified)
      const timeoutHandle = this.scheduleTimeout(chatJid, FOREVER, true);
      const recoverySession: LiveSession = {
        chatJid,
        messageId,
        logFilePath,
        latestLat: lat,
        latestLng: lng,
        latestHorizontalAccuracy: horizontalAccuracy,
        latestHeading: heading,
        livePeriod: FOREVER,
        isRecovery: true,
        timeoutHandle,
      };
      this.sessions.set(chatJid, recoverySession);
      return 'recovery-created';
    }

    // Unknown message, no log file — silently ignore
    logger.warn(
      { chatJid, messageId },
      'Received live location update for unknown session with no log file',
    );
    return 'updated';
  }

  /** Remove session and fire onStopped callback. */
  stopSession(chatJid: string): void {
    const session = this.sessions.get(chatJid);
    if (!session) return;
    clearTimeout(session.timeoutHandle);
    this.sessions.delete(chatJid);
    this.opts.onStopped(chatJid);
  }

  getLatestPosition(
    chatJid: string,
  ):
    | Pick<
        LiveSession,
        | 'latestLat'
        | 'latestLng'
        | 'latestHorizontalAccuracy'
        | 'latestHeading'
        | 'logFilePath'
      >
    | undefined {
    const session = this.sessions.get(chatJid);
    if (!session) return undefined;
    return {
      latestLat: session.latestLat,
      latestLng: session.latestLng,
      latestHorizontalAccuracy: session.latestHorizontalAccuracy,
      latestHeading: session.latestHeading,
      logFilePath: session.logFilePath,
    };
  }

  /** Delete log files (and rotated copies) older than LOG_RETENTION_MS. */
  cleanupOldLogs(): void {
    const now = Date.now();
    try {
      const entries = fs.readdirSync(this.opts.logDir);
      for (const entry of entries) {
        if (!entry.endsWith('.log') && !/\.log\.\d+$/.test(entry)) continue;
        const fullPath = path.join(this.opts.logDir, entry);
        try {
          const { mtimeMs } = fs.statSync(fullPath);
          if (now - mtimeMs > LOG_RETENTION_MS) {
            fs.unlinkSync(fullPath);
            logger.debug({ fullPath }, 'Deleted old location log');
          }
          // eslint-disable-next-line no-catch-all/no-catch-all
        } catch (err) {
          logger.warn({ fullPath, err }, 'Error cleaning up location log');
        }
      }
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      logger.debug(
        { logDir: this.opts.logDir },
        'location_logs dir not found during cleanup, skipping',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private makeLogFilePath(chatJid: string, messageId: number): string {
    const rawId = chatJid.replace(/^tg:/, '');
    const sanitized = rawId.replace(/^-/, '_'); // -100123 → _100123
    return path.join(this.opts.logDir, `${sanitized}_${messageId}.log`);
  }

  private makeEntry(
    lat: number,
    lng: number,
    horizontalAccuracy?: number,
    heading?: number,
  ): LiveLocationEntry {
    const entry: LiveLocationEntry = {
      time: new Date().toISOString(),
      lat,
      lng,
    };
    if (horizontalAccuracy !== undefined)
      entry.horizontal_accuracy = horizontalAccuracy;
    if (heading !== undefined) entry.heading = heading;
    return entry;
  }

  private appendLogEntry(logFilePath: string, entry: LiveLocationEntry): void {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    const line = JSON.stringify(entry) + '\n';

    let size = 0;
    try {
      size = fs.statSync(logFilePath).size;
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      // File doesn't exist yet — size stays 0
    }

    if (size >= MAX_LOG_SIZE) {
      this.rotateLogs(logFilePath);
    }

    fs.appendFileSync(logFilePath, line, 'utf-8');
  }

  private rotateLogs(logFilePath: string): void {
    // Remove oldest backup
    try {
      fs.unlinkSync(`${logFilePath}.${MAX_BACKUPS}`);
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      /* not present */
    }
    // Shift .4→.5, .3→.4, ..., .1→.2
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${logFilePath}.${i}`, `${logFilePath}.${i + 1}`);
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch {
        /* not present */
      }
    }
    // .log → .log.1 (inode-safe: rename, not truncate)
    try {
      fs.renameSync(logFilePath, `${logFilePath}.1`);
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      /* not present */
    }
    // New .log will be created by the subsequent appendFileSync call
  }

  private computeTimeoutMs(livePeriod: number): number {
    if (livePeriod === FOREVER || livePeriod <= 0) {
      return this.opts.idleTimeoutMs;
    }
    return Math.min(livePeriod * 1000, this.opts.idleTimeoutMs);
  }

  private scheduleTimeout(
    chatJid: string,
    livePeriod: number,
    isRecovery: boolean,
  ): ReturnType<typeof setTimeout> {
    const ms = this.computeTimeoutMs(livePeriod);
    return setTimeout(() => {
      this.sessions.delete(chatJid);
      // Recovery sessions don't notify the agent (it was never told about the start)
      if (!isRecovery) {
        this.opts.onTimeout(chatJid);
      }
    }, ms);
  }
}
