/**
 * CLI channel — talk to your agent from a local terminal via Unix socket.
 *
 * Always-on, zero-credentials channel that ships with main. The daemon
 * listens on `data/cli.sock`; the `scripts/chat.ts` client connects, writes
 * a JSON line per message, reads JSON lines back. The channel plumbs into
 * the normal router/delivery path like any other adapter — `/clear` and
 * other session-level commands work identically.
 *
 * Wire format: one JSON object per line.
 *
 *   Client → server:
 *     { "text": "user message" }                          # default — talk to cli/local
 *     { "text": "...", "to": {"channelType": "discord",
 *                             "platformId": "discord:@me:149...",
 *                             "threadId": null} }         # route to a specific mg
 *     { "text": "...", "to": {...}, "reply_to": {...} }   # + redirect replies
 *     { "deliver": {"channelType": "whatsapp",
 *                    "platformId": "12036340…@g.us",
 *                    "threadId": null,
 *                    "text": "outbound text"} }            # raw outbound: skip
 *                                                          # the agent loop and call
 *                                                          # the channel adapter's
 *                                                          # deliver() directly. Used
 *                                                          # by scripts/send-message.py
 *                                                          # for WhatsApp (and any
 *                                                          # other adapter whose
 *                                                          # session lives here).
 *   Server → client:
 *     { "text": "agent reply" }                            # chat / `to` paths
 *     { "ok": true,  "messageId": "..." }                  # deliver path success
 *     { "ok": false, "error":   "..." }                    # deliver path failure
 *
 * The `to` and `reply_to` addressing is how admin transports (the bootstrap
 * script) inject messages targeting any wired channel. `reply_to` is a
 * router-layer concept — agents cannot set it; it is carried only on
 * inbound events from CLI clients that hold operator privilege (the socket
 * is chmod 0600, so "connected to this socket" ≈ "is the owner").
 *
 * Single-client chat semantics: one connected terminal at a time. A second
 * "chat" connection closes the first with a "superseded" notice. Admin
 * route-opcode connections (`to` set) are one-shot and do NOT evict an
 * active chat client.
 *
 * deliver() silently no-ops when no client is connected. The outbound row
 * is already in outbound.db, so the message isn't lost — it just doesn't
 * reach this run's terminal. Reconnect to see subsequent replies.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, DeliveryAddress, InboundEvent, OutboundMessage } from './adapter.js';
import { getChannelAdapter, registerChannelAdapter } from './channel-registry.js';

const PLATFORM_ID = 'local';

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function createAdapter(): ChannelAdapter {
  let server: net.Server | null = null;
  let client: net.Socket | null = null;

  const adapter: ChannelAdapter = {
    name: 'cli',
    channelType: 'cli',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      const sock = socketPath();

      // Stale socket cleanup: a previous run that crashed may have left the
      // file behind, and net.createServer refuses to bind to an existing path.
      try {
        fs.unlinkSync(sock);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') {
          log.warn('Failed to unlink stale CLI socket (will try to bind anyway)', { sock, err });
        }
      }

      server = net.createServer((socket) => handleConnection(socket, config));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(sock, () => {
          // Tighten perms so only the owner can connect. Unix socket files
          // obey filesystem perms — 0700 on the socket means other local
          // users can't send into this agent.
          try {
            fs.chmodSync(sock, 0o600);
          } catch (err) {
            log.warn('Failed to chmod CLI socket (continuing)', { sock, err });
          }
          log.info('CLI channel listening', { sock });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      if (client) {
        try {
          client.end();
        } catch {
          // swallow — teardown is best-effort
        }
        client = null;
      }
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
      // Remove the socket file so a relaunch doesn't trip over it.
      try {
        fs.unlinkSync(socketPath());
      } catch {
        // swallow
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      if (!client) {
        // No live terminal — outbound row is already persisted, so this
        // isn't a data loss. User will see it on the next connect cycle
        // (or never, if we don't add scroll-back). Not worth throwing.
        return undefined;
      }
      const text = extractText(message);
      if (text === null) return undefined;
      try {
        client.write(JSON.stringify({ text }) + '\n');
      } catch (err) {
        log.warn('Failed to write to CLI client', { err });
      }
      return undefined;
    },
  };

  function handleConnection(socket: net.Socket, config: ChannelSetup): void {
    // Defer the chat-slot swap until we see the first line — if it turns out
    // to be a routed (`to`-bearing) one-shot, we leave the existing chat
    // client in place. Only plain chat connections participate in supersede.
    let claimedChatSlot = false;

    const claimChatSlot = () => {
      if (claimedChatSlot) return;
      claimedChatSlot = true;
      if (client && client !== socket) {
        try {
          client.write(JSON.stringify({ text: '[superseded by a newer client]' }) + '\n');
          client.end();
        } catch {
          // swallow
        }
      }
      client = socket;
      log.info('CLI client connected');
    };

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        void handleLine(line, socket, config, claimChatSlot);
      }
    });

    socket.on('close', () => {
      if (client === socket) client = null;
      if (claimedChatSlot) log.info('CLI client disconnected');
    });

    socket.on('error', (err) => {
      log.warn('CLI client socket error', { err });
    });
  }

  async function handleLine(
    line: string,
    socket: net.Socket,
    config: ChannelSetup,
    claimChatSlot: () => void,
  ): Promise<void> {
    let payload: {
      text?: unknown;
      to?: unknown;
      reply_to?: unknown;
      sender?: unknown;
      senderId?: unknown;
      deliver?: unknown;
    };
    try {
      payload = JSON.parse(line);
    } catch (err) {
      log.warn('CLI: ignoring non-JSON line from client', { line });
      return;
    }
    // Outbound 'deliver' opcode — bypass the agent loop and call a wired channel
    // adapter's deliver() directly. Used by scripts/send-message.py for any
    // channel whose session lives in this daemon (WhatsApp via Baileys, etc.).
    // Replies with a single JSON line and closes the per-line response cycle;
    // does NOT claim the chat slot.
    if (payload.deliver && typeof payload.deliver === 'object') {
      const d = payload.deliver as Record<string, unknown>;
      const channelType = typeof d.channelType === 'string' ? d.channelType : null;
      const platformId = typeof d.platformId === 'string' ? d.platformId : null;
      const threadId =
        d.threadId === null || d.threadId === undefined ? null : typeof d.threadId === 'string' ? d.threadId : null;
      const text = typeof d.text === 'string' ? d.text : null;

      if (!channelType || !platformId || text === null) {
        replyDeliver(false, undefined, 'deliver opcode requires {channelType, platformId, text}');
        return;
      }
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        replyDeliver(false, undefined, `no active channel adapter for channelType=${channelType}`);
        return;
      }
      const message: OutboundMessage = {
        kind: 'chat',
        content: { text },
      };
      try {
        const messageId = await adapter.deliver(platformId, threadId, message);
        replyDeliver(true, messageId, undefined);
      } catch (err) {
        log.error('CLI: deliver opcode threw', { channelType, platformId, err });
        replyDeliver(false, undefined, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (typeof payload.text !== 'string' || payload.text.length === 0) return;

    const to = parseAddress(payload.to);
    const replyTo = parseAddress(payload.reply_to);

    function replyDeliver(success: boolean, messageId?: string, errMsg?: string): void {
      try {
        const reply: Record<string, unknown> = { ok: success };
        if (messageId !== undefined) reply.messageId = messageId;
        if (errMsg !== undefined) reply.error = errMsg;
        socket.write(JSON.stringify(reply) + '\n');
      } catch (writeErr) {
        log.warn('CLI: failed to write deliver reply', { writeErr });
      }
    }

    if (to) {
      // Routed message — admin transport. Build a full InboundEvent targeting
      // `to`'s channel/platform, and let `reply_to` (if any) redirect replies.
      // Does NOT claim the chat slot, so an active terminal chat isn't evicted.
      const event: InboundEvent = {
        channelType: to.channelType,
        platformId: to.platformId,
        threadId: to.threadId,
        message: {
          id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({
            text: payload.text,
            sender: typeof payload.sender === 'string' ? payload.sender : 'cli',
            senderId: typeof payload.senderId === 'string' ? payload.senderId : `cli:${PLATFORM_ID}`,
          }),
        },
        replyTo: replyTo ?? undefined,
      };
      try {
        await config.onInboundEvent(event);
      } catch (err) {
        log.error('CLI: onInboundEvent threw', { err });
      }
      return;
    }

    // Plain chat — claim the slot (evicting any prior client) and route via
    // the standard onInbound path (adapter injects its own channelType).
    claimChatSlot();
    try {
      await config.onInbound(PLATFORM_ID, null, {
        id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: {
          text: payload.text,
          sender: 'cli',
          senderId: `cli:${PLATFORM_ID}`,
        },
      });
    } catch (err) {
      log.error('CLI: onInbound threw', { err });
    }
  }

  function parseAddress(raw: unknown): DeliveryAddress | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.channelType !== 'string' || typeof obj.platformId !== 'string') return null;
    const threadId =
      obj.threadId === null || obj.threadId === undefined
        ? null
        : typeof obj.threadId === 'string'
          ? obj.threadId
          : null;
    return {
      channelType: obj.channelType,
      platformId: obj.platformId,
      threadId,
    };
  }

  return adapter;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

registerChannelAdapter('cli', { factory: createAdapter });
