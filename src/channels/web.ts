/**
 * Web channel for NanoClaw.
 * Hono HTTP server with streaming text responses for useChat + TextStreamChatTransport.
 */
import crypto from 'crypto';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { serve } from '@hono/node-server';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { ASSISTANT_NAME, MAIN_GROUP_FOLDER, WEB_API_PORT } from '../config.js';
import {
  getDatabase,
  getAllWebSessions,
  getMessageHistory,
  getWebSession,
  insertWebSession,
  storeChatMetadata,
  storeMessageDirect,
  updateWebSessionActivity,
} from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

import type { Server } from 'http';

const JID_SUFFIX = '@web';
const SENDER_NAME_PATTERN = /^[a-zA-Z0-9 _-]{1,64}$/;
const MAX_BODY_SIZE = 64 * 1024; // 64KB

// Rate limiting state
const rateLimits = {
  sessions: new Map<string, number[]>(), // token -> timestamps
  messages: new Map<string, number[]>(),
};
const RATE_LIMIT_SESSIONS_PER_MIN = 10;
const RATE_LIMIT_MESSAGES_PER_MIN = 30;

// Share one TextEncoder per process
const encoder = new TextEncoder();

export interface WebChannelOpts {
  authToken: string;
  port?: number;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  onDirectEnqueue: (chatJid: string) => void;
}

interface PendingResponse {
  write: (text: string) => void;
  close: () => void;
  canceled: boolean;
  writeQueue: Promise<void>;
  createdAt: number;
}

export class WebChannel implements Channel {
  name = 'web';

  private connected = false;
  private server: Server | null = null;
  private opts: WebChannelOpts;
  private pendingResponses = new Map<string, PendingResponse>();
  private lastActivityUpdated = new Map<string, number>();
  private orphanSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WebChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const port = this.opts.port ?? WEB_API_PORT;
    const app = new Hono();

    // Health endpoint (no auth)
    app.get('/api/health', (c) => c.json({ status: 'ok' }));

    // Auth middleware for all other /api routes
    app.use('/api/*', bearerAuth({ token: this.opts.authToken }));

    // --- Session CRUD ---

    const createSessionSchema = z.object({
      name: z.string().min(1).max(200).default('Web Chat'),
    });

    app.post('/api/sessions', zValidator('json', createSessionSchema), (c) => {
      // Rate limit
      if (this.isRateLimited('sessions')) {
        return c.json(
          {
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many sessions created',
            },
          },
          429,
        );
      }

      const { name } = c.req.valid('json');
      const sessionId = `web-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const jid = `${sessionId}${JID_SUFFIX}`;

      // Atomic session creation: web_sessions + chats + registered_groups
      const db = getDatabase();
      db.transaction(() => {
        insertWebSession(sessionId, jid, name, MAIN_GROUP_FOLDER);
        storeChatMetadata(jid, new Date().toISOString(), name, 'web', false);
        this.opts.registerGroup(jid, {
          name,
          folder: MAIN_GROUP_FOLDER,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });
      })();

      // Ensure group folder exists
      try {
        const groupDir = resolveGroupFolderPath(MAIN_GROUP_FOLDER);
        const fs = require('fs');
        fs.mkdirSync(require('path').join(groupDir, 'logs'), {
          recursive: true,
        });
      } catch {
        // ignore — folder likely already exists
      }

      logger.info({ sessionId, jid }, 'Web session created');
      return c.json({ sessionId, jid }, 201);
    });

    app.get('/api/sessions', (c) => {
      const sessions = getAllWebSessions();
      return c.json({
        sessions: sessions.map((s) => ({
          id: s.session_id,
          jid: s.jid,
          name: s.name,
          createdAt: s.created_at,
          lastActivity: s.last_activity,
        })),
      });
    });

    // --- Message history ---

    app.get('/api/sessions/:id/messages', (c) => {
      const { id } = c.req.param();
      const session = getWebSession(id);
      if (!session) {
        return c.json(
          {
            error: {
              code: 'SESSION_NOT_FOUND',
              message: `Session ${id} does not exist`,
            },
          },
          404,
        );
      }

      const before = c.req.query('before');
      const limit = Math.min(
        parseInt(c.req.query('limit') || '50', 10) || 50,
        200,
      );

      const rows = getMessageHistory(session.jid, limit, before || undefined);

      // Return in chronological order (DB returns DESC)
      const messages = rows.reverse().map((m) => ({
        id: m.id,
        senderName: m.sender_name,
        content: m.content,
        timestamp: m.timestamp,
        isBotMessage: m.is_bot_message === 1,
      }));

      return c.json({ messages });
    });

    // --- Streaming chat endpoint ---

    const chatSchema = z.object({
      content: z.string().min(1).max(MAX_BODY_SIZE),
      senderName: z.string().default('User'),
    });

    app.post(
      '/api/sessions/:id/chat',
      zValidator('json', chatSchema),
      async (c) => {
        const { id } = c.req.param();
        const { content, senderName } = c.req.valid('json');

        // Rate limit
        if (this.isRateLimited('messages')) {
          return c.json(
            { error: { code: 'RATE_LIMITED', message: 'Too many messages' } },
            429,
          );
        }

        const session = getWebSession(id);
        if (!session) {
          return c.json(
            {
              error: {
                code: 'SESSION_NOT_FOUND',
                message: `Session ${id} does not exist`,
              },
            },
            404,
          );
        }

        // Validate senderName
        const safeName =
          SENDER_NAME_PATTERN.test(senderName) &&
          senderName.toLowerCase() !== ASSISTANT_NAME.toLowerCase()
            ? senderName
            : 'User';

        const jid = session.jid;

        // Reject if already processing (prevents multi-tab conflicts)
        if (this.pendingResponses.has(jid)) {
          return c.json(
            {
              error: {
                code: 'SESSION_BUSY',
                message: 'Session is already processing a message',
              },
            },
            409,
          );
        }

        const msgId = `web-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const timestamp = new Date().toISOString();

        // Store inbound message
        const msg = {
          id: msgId,
          chat_jid: jid,
          sender: jid,
          sender_name: safeName,
          content,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        };
        storeMessageDirect(msg);
        this.opts.onMessage(jid, {
          ...msg,
          is_from_me: false,
          is_bot_message: false,
        });

        // Update last activity (debounced)
        this.debouncedUpdateActivity(id);

        // Set up streaming response
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();

        const pending: PendingResponse = {
          write: (text: string) =>
            writer.write(encoder.encode(text)).catch(() => {}),
          close: () => {
            this.pendingResponses.delete(jid);
            writer.close().catch(() => {});
          },
          canceled: false,
          writeQueue: Promise.resolve(),
          createdAt: Date.now(),
        };
        this.pendingResponses.set(jid, pending);

        // Heartbeat to prevent proxy idle timeouts
        const heartbeat = setInterval(() => {
          if (!pending.canceled) {
            writer.write(encoder.encode('')).catch(() => {});
          }
        }, 30_000);

        // Clean up on client disconnect
        c.req.raw.signal.addEventListener('abort', () => {
          pending.canceled = true;
          clearInterval(heartbeat);
          this.pendingResponses.delete(jid);
          writer.close().catch(() => {});
        });

        // Trigger processing (bypass polling loop)
        this.opts.onDirectEnqueue(jid);

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Transfer-Encoding': 'chunked',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-cache',
          },
        });
      },
    );

    // Start server
    try {
      this.server = serve({
        fetch: app.fetch,
        port,
        hostname: '127.0.0.1',
      }) as Server;

      // Configure timeouts for long-running agent responses
      this.server.requestTimeout = 0; // Disable (default 300s too low)
      this.server.keepAliveTimeout = 60_000; // 60s

      this.connected = true;

      // Periodic sweep for orphaned pending responses
      this.orphanSweepTimer = setInterval(() => this.sweepOrphans(), 60_000);

      logger.info({ port }, 'Web channel connected (HTTP)');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        logger.warn({ port }, 'Web channel port in use, skipping');
      } else {
        throw err;
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const pending = this.pendingResponses.get(jid);
    if (pending && !pending.canceled) {
      // Chain writes to serialize and prevent garble
      pending.writeQueue = pending.writeQueue.then(() =>
        this.writeSmooth(pending, text),
      );
    }

    // Also store in DB for history
    const msgId = `web-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    storeMessageDirect({
      id: msgId,
      chat_jid: jid,
      sender: 'assistant',
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) {
      const pending = this.pendingResponses.get(jid);
      if (pending) {
        // Wait for all queued writes to finish before closing
        await pending.writeQueue;
        pending.close();
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(JID_SUFFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.orphanSweepTimer) {
      clearInterval(this.orphanSweepTimer);
      this.orphanSweepTimer = null;
    }

    // Close all pending responses
    for (const [jid, pending] of this.pendingResponses) {
      pending.canceled = true;
      try {
        pending.close();
      } catch {
        // ignore
      }
    }
    this.pendingResponses.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  /**
   * Notify the web channel of a container error for a session.
   * Writes an in-band error message before closing the stream.
   */
  notifyError(jid: string): void {
    const pending = this.pendingResponses.get(jid);
    if (pending && !pending.canceled) {
      pending.writeQueue = pending.writeQueue.then(() => {
        if (!pending.canceled) {
          pending.write(
            '\n\n[Error: Agent encountered an issue. Your message has been saved — try again.]',
          );
        }
      });
    }
  }

  /**
   * Smooth streaming: buffer container output and release word-by-word.
   * Prevents jerky rendering from irregular chunk sizes.
   */
  private async writeSmooth(
    pending: PendingResponse,
    text: string,
    delayMs = 5,
  ): Promise<void> {
    const parts = text.split(/(?<=\s)/); // split after whitespace, preserving it
    const chunkSize = parts.length > 200 ? 3 : 1; // adaptive chunking for long texts

    for (let i = 0; i < parts.length; i += chunkSize) {
      if (pending.canceled) return;
      try {
        pending.write(parts.slice(i, i + chunkSize).join(''));
      } catch {
        return; // Writer closed
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  private debouncedUpdateActivity(sessionId: string): void {
    const now = Date.now();
    if (now - (this.lastActivityUpdated.get(sessionId) ?? 0) < 60_000) return;
    this.lastActivityUpdated.set(sessionId, now);
    updateWebSessionActivity(sessionId);
  }

  private sweepOrphans(): void {
    const maxAge = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();
    for (const [jid, pending] of this.pendingResponses) {
      if (now - pending.createdAt > maxAge) {
        logger.warn({ jid }, 'Sweeping orphaned pending response');
        pending.canceled = true;
        try {
          pending.close();
        } catch {
          // ignore
        }
      }
    }
  }

  private isRateLimited(type: 'sessions' | 'messages'): boolean {
    const map = type === 'sessions' ? rateLimits.sessions : rateLimits.messages;
    const limit =
      type === 'sessions'
        ? RATE_LIMIT_SESSIONS_PER_MIN
        : RATE_LIMIT_MESSAGES_PER_MIN;
    const key = 'global'; // Single-token system — rate limit globally
    const now = Date.now();
    const windowMs = 60_000;

    let timestamps = map.get(key);
    if (!timestamps) {
      timestamps = [];
      map.set(key, timestamps);
    }

    // Remove timestamps outside the window
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= limit) return true;
    timestamps.push(now);
    return false;
  }
}
