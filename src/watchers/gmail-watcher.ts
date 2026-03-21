/**
 * GmailWatcher — polls Gmail API for new messages and routes them through
 * the EventRouter as EmailPayload events.
 *
 * State (last-processed message IDs + historyId) is persisted to
 * stateDir/gmail-state.json so re-starts don't reprocess old messages.
 */

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { logger } from '../logger.js';
import type { EventRouter } from '../event-router.js';
import type { EmailPayload } from '../classification-prompts.js';

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface GmailWatcherConfig {
  /** Path to credentials.json (contains installed.client_id etc. + token) */
  credentialsPath: string;
  /** Gmail account address (used for logging) */
  account: string;
  /** EventRouter instance to receive parsed emails */
  eventRouter: EventRouter;
  /** How often to poll, in milliseconds */
  pollIntervalMs: number;
  /** Directory where gmail-state.json is persisted */
  stateDir: string;
}

export interface GmailWatcherStatus {
  mode: 'polling';
  account: string;
  lastCheck: string | null;
  messagesProcessed: number;
}

// ─── Internal state shape ─────────────────────────────────────────────────────

interface GmailState {
  processedIds: string[];
  lastHistoryId?: string;
}

// ─── Raw Gmail message shape (partial) ───────────────────────────────────────

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailRawMessage {
  id?: string | null;
  threadId?: string | null;
  snippet?: string | null;
  labelIds?: string[] | null;
  payload?: {
    headers?: GmailHeader[];
    parts?: GmailPart[];
    mimeType?: string;
    body?: { attachmentId?: string; size?: number };
  };
}

// ─── GmailWatcher ────────────────────────────────────────────────────────────

export class GmailWatcher {
  private config: GmailWatcherConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private auth: OAuth2Client | null = null;
  private messagesProcessed = 0;
  private lastCheck: string | null = null;
  private stateFilePath: string;
  private state: GmailState = { processedIds: [] };

  constructor(config: GmailWatcherConfig) {
    this.config = config;
    this.stateFilePath = path.join(config.stateDir, 'gmail-state.json');
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info({ account: this.config.account }, 'GmailWatcher starting');
    this.auth = await this.authenticate();
    this.loadState();
    await this.poll();
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info({ account: this.config.account }, 'GmailWatcher stopped');
  }

  getStatus(): GmailWatcherStatus {
    return {
      mode: 'polling',
      account: this.config.account,
      lastCheck: this.lastCheck,
      messagesProcessed: this.messagesProcessed,
    };
  }

  // ─── Static helpers ────────────────────────────────────────────────────────

  /**
   * Parses a raw Gmail API message object into an EmailPayload.
   * Handles missing fields gracefully.
   */
  static parseMessage(msg: GmailRawMessage): EmailPayload {
    const headers: GmailHeader[] = msg.payload?.headers ?? [];

    const getHeader = (name: string): string => {
      const lower = name.toLowerCase();
      return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? '';
    };

    const splitAddresses = (raw: string): string[] => {
      if (!raw.trim()) return [];
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    };

    const hasAttachments = GmailWatcher.detectAttachments(
      msg.payload?.parts ?? [],
    );

    return {
      messageId: msg.id ?? '',
      threadId: msg.threadId ?? '',
      from: getHeader('From'),
      to: splitAddresses(getHeader('To')),
      cc: splitAddresses(getHeader('Cc')),
      subject: getHeader('Subject'),
      snippet: msg.snippet ?? '',
      date: getHeader('Date'),
      labels: msg.labelIds ?? [],
      hasAttachments,
    };
  }

  // ─── Private methods ───────────────────────────────────────────────────────

  private async authenticate(): Promise<OAuth2Client> {
    const raw = fs.readFileSync(this.config.credentialsPath, 'utf-8');
    const creds = JSON.parse(raw) as {
      installed?: {
        client_id: string;
        client_secret: string;
        redirect_uris: string[];
        token?: Record<string, unknown>;
      };
      web?: {
        client_id: string;
        client_secret: string;
        redirect_uris: string[];
        token?: Record<string, unknown>;
      };
    };

    const data = creds.installed ?? creds.web;
    if (!data) {
      throw new Error(
        `credentials.json at ${this.config.credentialsPath} has no "installed" or "web" key`,
      );
    }

    const client = new OAuth2Client(
      data.client_id,
      data.client_secret,
      data.redirect_uris[0],
    );

    if (data.token) {
      client.setCredentials(data.token);
    }

    return client;
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        this.state = JSON.parse(raw) as GmailState;
        logger.debug(
          {
            account: this.config.account,
            processedCount: this.state.processedIds.length,
          },
          'GmailWatcher loaded persisted state',
        );
      }
    } catch (err) {
      logger.warn(
        { err, account: this.config.account },
        'GmailWatcher failed to load state — starting fresh',
      );
      this.state = { processedIds: [] };
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      fs.writeFileSync(
        this.stateFilePath,
        JSON.stringify(this.state, null, 2),
        'utf-8',
      );
    } catch (err) {
      logger.warn(
        { err, account: this.config.account },
        'GmailWatcher failed to save state',
      );
    }
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      void this.poll().then(() => this.scheduleNext());
    }, this.config.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (!this.auth) return;

    const gmail = google.gmail({ version: 'v1', auth: this.auth });
    this.lastCheck = new Date().toISOString();

    try {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        labelIds: ['INBOX'],
        maxResults: 50,
      });

      const messages = listRes.data.messages ?? [];
      const processedSet = new Set(this.state.processedIds);

      for (const stub of messages) {
        if (!stub.id || processedSet.has(stub.id)) continue;

        try {
          const msgRes = await gmail.users.messages.get({
            userId: 'me',
            id: stub.id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
          });

          const raw = msgRes.data as GmailRawMessage;
          const payload = GmailWatcher.parseMessage(raw);

          await this.config.eventRouter.route({
            type: 'email',
            id: stub.id,
            timestamp: new Date().toISOString(),
            payload: payload as unknown as Record<string, unknown>,
          });

          processedSet.add(stub.id);
          this.messagesProcessed++;
        } catch (err) {
          logger.warn(
            { err, messageId: stub.id, account: this.config.account },
            'GmailWatcher failed to fetch/route message — skipping',
          );
        }
      }

      // Keep only the last 2000 processed IDs to bound memory/file size
      const MAX_PROCESSED = 2000;
      const allIds = Array.from(processedSet);
      this.state.processedIds = allIds.slice(
        Math.max(0, allIds.length - MAX_PROCESSED),
      );

      this.saveState();

      logger.debug(
        {
          account: this.config.account,
          newMessages: this.messagesProcessed,
          polled: messages.length,
        },
        'GmailWatcher poll complete',
      );
    } catch (err) {
      logger.warn(
        { err, account: this.config.account },
        'GmailWatcher poll failed',
      );
    }
  }

  private static detectAttachments(parts: GmailPart[]): boolean {
    for (const part of parts) {
      // A part with an attachmentId and a non-empty size is a real attachment
      if (part.body?.attachmentId && (part.body.size ?? 0) > 0) {
        return true;
      }
      // Recurse into nested parts (multipart/*)
      if (part.parts && GmailWatcher.detectAttachments(part.parts)) {
        return true;
      }
    }
    return false;
  }
}
