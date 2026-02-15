---
name: add-qqbot
description: Add QQBot as a channel. Can replace WhatsApp entirely or run alongside it. Also configurable as a control-only channel (triggers actions) or passive channel (receives notifications only).
---
# Add QQBot Channel

This skill adds QQBot support to NanoClaw using QQ's official Open Platform API. Users can choose to:
1. **Replace WhatsApp** - Use QQBot as the only messaging channel
2. **Add alongside WhatsApp** - Both channels active
3. **Control channel** - QQBot triggers agent but doesn't receive all outputs
4. **Notification channel** - Receives outputs but limited triggering

## Prerequisites

### 1. Install Dependencies

```bash
npm install ws @types/ws
```

WebSocket is needed for QQ Open Platform's event subscription gateway.

### 2. Create QQBot Application

Tell the user:

> I need you to create a QQ bot:
>
> 1. Visit [QQ Open Platform](https://q.qq.com) or [QQ Bot Documentation](https://bot.q.qq.com/wiki)
> 2. Create a bot application
> 3. Get your `AppID` and `ClientSecret`
> 4. Note: QQ bots use a **long-connection event subscription** mechanism - no public webhook URL needed
> 5. Sandbox mode supports private chats (C2C) without full publication

Wait for user to provide the credentials.

### 3. Understand QQ Message Types

Tell the user:

> QQ supports three types of messages:
>
> **C2C (Private Message)**: Direct messages between users
> - JID format: `c2c:{openid}`
> - OpenID is a 32-character hex string (not your QQ number)
>
> **Group Message**: Messages in QQ groups
> - JID format: `group:{groupOpenid}`
> - Requires @mention to trigger in groups
>
> **Channel Message**: Messages in QQ channels (guilds)
> - JID format: `channel:{channelId}`
>
> **Important**: QQ uses OpenID for privacy. You'll get the OpenID from incoming messages.

### 4. No Public IP Required

Tell the user:

> **Good news**: QQ Bot works without a public IP address. It uses a WebSocket connection where your bot connects to QQ's servers (client mode), similar to how WhatsApp works. Messages are pushed to you through this persistent connection.

## Questions to Ask

Before making changes, ask:

1. **Mode**: Replace WhatsApp or add alongside it?
   - If replace: Set `QQBOT_ONLY=true`
   - If alongside: Both will run

2. **Sandbox mode**: Are you using sandbox (development) or production?
   - Sandbox: Limited to private chats, no group support
   - Production: Full features after bot approval

3. **Chat behavior**: Should your main chat respond to all messages or only when @mentioned?
   - Main chat: Responds to all (set `requiresTrigger: false`)
   - Other chats: Default requires trigger (`requiresTrigger: true`)

## Architecture

NanoClaw uses a **Channel abstraction** (`Channel` interface in `src/types.ts`). Each messaging platform implements this interface. Key files:

| File | Purpose |
|------|---------|
| `src/types.ts` | `Channel` interface definition |
| `src/channels/whatsapp.ts` | `WhatsAppChannel` class (reference implementation) |
| `src/router.ts` | `findChannel()`, `routeOutbound()`, `formatOutbound()` |
| `src/index.ts` | Orchestrator: creates channels, wires callbacks, starts subsystems |
| `src/ipc.ts` | IPC watcher (uses `sendMessage` dep for outbound) |

The QQBot channel follows the same pattern as WhatsApp:
- Implements `Channel` interface (`connect`, `sendMessage`, `ownsJid`, `disconnect`, `setTyping`)
- Delivers inbound messages via `onMessage` / `onChatMetadata` callbacks
- The existing message loop in `src/index.ts` picks up stored messages automatically

## Implementation

### Step 1: Update Configuration

Read `src/config.ts` and add QQBot config exports:

```typescript
export const QQBOT_APP_ID = process.env.QQBOT_APP_ID || '';
export const QQBOT_CLIENT_SECRET = process.env.QQBOT_CLIENT_SECRET || '';
export const QQBOT_SANDBOX = process.env.QQBOT_SANDBOX === 'true';
export const QQBOT_ONLY = process.env.QQBOT_ONLY === 'true';
```

These should be added near the top with other configuration exports.

### Step 2: Create QQBot Channel

Create `src/channels/qqbot.ts` implementing the `Channel` interface. This implementation is based on the verified qqbot project and uses QQ's official WebSocket gateway protocol.

```typescript
import WebSocket from 'ws';
import https from 'https';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface QQBotChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAutoRegister?: (jid: string, type: 'c2c' | 'group' | 'channel') => void;
}

interface QQBotConfig {
  appId: string;
  clientSecret: string;
  sandbox: boolean;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

interface WebSocketPayload {
  op: number;  // Operation code
  d: any;      // Data
  s?: number;  // Sequence number
  t?: string;  // Event type
}

interface QQBotMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    user_openid?: string;
    member_openid?: string;
  };
  group_openid?: string;
  channel_id?: string;
}

export class QQBotChannel implements Channel {
  name = 'qqbot';
  prefixAssistantName = true;

  /** Convert any ISO timestamp to UTC (Z suffix) for consistent DB ordering */
  private toUTC(ts: string): string {
    return new Date(ts).toISOString();
  }

  private ws: WebSocket | null = null;
  private config: QQBotConfig;
  private opts: QQBotChannelOpts;

  // Authentication
  private tokenCache: TokenCache | null = null;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;

  // WebSocket session
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs: number = 41250; // Default, updated by server

  // Connection management
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];

  // Message handling
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private messageCache = new Set<string>();
  private readonly CACHE_TTL = 60000;

  constructor(appId: string, clientSecret: string, sandbox: boolean, opts: QQBotChannelOpts) {
    this.config = { appId, clientSecret, sandbox };
    this.opts = opts;
  }

  async connect(): Promise<void> {
    logger.info('QQBot: Starting connection...');
    await this.authenticate();
    await this.connectWebSocket();
  }

  private async authenticate(): Promise<void> {
    // Check cache (refresh 5 minutes early)
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 5 * 60 * 1000) {
      logger.debug('QQBot: Using cached token');
      return;
    }

    logger.info('QQBot: Fetching access token...');

    const data = JSON.stringify({
      appId: this.config.appId,
      clientSecret: this.config.clientSecret,
    });

    const options = {
      hostname: 'bots.qq.com',
      path: '/app/getAppAccessToken',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (result.access_token) {
              const expiresIn = result.expires_in || 7200;
              this.tokenCache = {
                token: result.access_token,
                expiresAt: Date.now() + expiresIn * 1000,
              };
              logger.info({ expiresIn }, 'QQBot: Authentication successful');
              this.scheduleTokenRefresh(expiresIn);
              resolve();
            } else {
              reject(new Error(`QQ auth failed: ${body}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  private scheduleTokenRefresh(expiresIn: number): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    // Refresh 5 minutes before expiry + random 0-30s jitter
    const refreshTime = (expiresIn - 300) * 1000 + Math.random() * 30000;
    this.tokenRefreshTimer = setTimeout(() => {
      logger.info('QQBot: Refreshing token...');
      this.authenticate().catch((err) => {
        logger.error({ err }, 'QQBot: Token refresh failed');
      });
    }, refreshTime);
  }

  private async getGatewayUrl(): Promise<string> {
    if (!this.tokenCache) {
      throw new Error('QQBot: Not authenticated');
    }

    const options = {
      hostname: 'api.sgroup.qq.com',
      path: '/gateway',
      method: 'GET',
      headers: {
        Authorization: `QQBot ${this.tokenCache.token}`,
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (result.url) {
              resolve(result.url);
            } else {
              reject(new Error(`Failed to get gateway URL: ${body}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  private async connectWebSocket(): Promise<void> {
    const gatewayUrl = await this.getGatewayUrl();
    logger.info({ gatewayUrl }, 'QQBot: Connecting to WebSocket gateway...');

    this.ws = new WebSocket(gatewayUrl);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('QQBot: WebSocket connection timeout'));
      }, 30000);

      this.ws!.on('open', () => {
        clearTimeout(timeout);
        logger.info('QQBot: WebSocket connected');
        resolve();
      });

      this.ws!.on('message', (data: Buffer) => {
        this.handleWebSocketMessage(data);
      });

      this.ws!.on('close', (code, reason) => {
        this.connected = false;
        logger.info({ code, reason: reason.toString() }, 'QQBot: WebSocket closed');
        this.stopHeartbeat();
        this.scheduleReconnect();
      });

      this.ws!.on('error', (error) => {
        logger.error({ err: error }, 'QQBot: WebSocket error');
        if (!this.connected) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  private handleWebSocketMessage(data: Buffer): void {
    try {
      const payload: WebSocketPayload = JSON.parse(data.toString());

      // Update sequence number for session resume
      if (payload.s !== undefined && payload.s !== null) {
        this.lastSeq = payload.s;
      }

      switch (payload.op) {
        case 10: // Hello - Server sends heartbeat interval
          this.handleHello(payload.d);
          break;

        case 0: // Dispatch - Event message
          this.handleDispatch(payload);
          break;

        case 11: // Heartbeat ACK
          logger.debug('QQBot: Heartbeat ACK received');
          break;

        case 7: // Reconnect - Server requests reconnect
          logger.info('QQBot: Server requested reconnect');
          this.ws?.close();
          break;

        case 9: // Invalid Session - Need to re-identify
          logger.warn('QQBot: Invalid session, clearing session data');
          this.sessionId = null;
          this.lastSeq = null;
          this.ws?.close();
          break;

        default:
          logger.debug({ op: payload.op }, 'QQBot: Unknown opcode');
      }
    } catch (err) {
      logger.error({ err }, 'QQBot: Failed to parse WebSocket message');
    }
  }

  private handleHello(data: any): void {
    this.heartbeatIntervalMs = data.heartbeat_interval || 41250;
    logger.info({ interval: this.heartbeatIntervalMs }, 'QQBot: Received Hello');

    // Send Identify or Resume
    if (this.sessionId && this.lastSeq !== null) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }

    this.startHeartbeat();
  }

  private sendIdentify(): void {
    if (!this.tokenCache) return;

    const payload = {
      op: 2,
      d: {
        token: `QQBot ${this.tokenCache.token}`,
        intents: 0 | (1 << 30) | (1 << 25) | (1 << 12), // C2C, GROUP_AT, AT messages
        shard: [0, 1],
      },
    };

    this.ws?.send(JSON.stringify(payload));
    logger.info('QQBot: Sent Identify');
  }

  private sendResume(): void {
    if (!this.tokenCache || !this.sessionId) return;

    const payload = {
      op: 6,
      d: {
        token: `QQBot ${this.tokenCache.token}`,
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    };

    this.ws?.send(JSON.stringify(payload));
    logger.info({ seq: this.lastSeq }, 'QQBot: Sent Resume');
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const payload = {
          op: 1,
          d: this.lastSeq,
        };
        this.ws.send(JSON.stringify(payload));
        logger.debug({ seq: this.lastSeq }, 'QQBot: Sent heartbeat');
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private handleDispatch(payload: WebSocketPayload): void {
    const eventType = payload.t;
    const data = payload.d;

    switch (eventType) {
      case 'READY':
        this.sessionId = data.session_id;
        this.connected = true;
        this.reconnectAttempts = 0;
        logger.info({ sessionId: this.sessionId }, 'QQBot: Ready');

        // Flush queued messages
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'QQBot: Failed to flush queue')
        );
        break;

      case 'RESUMED':
        // Session resumed successfully after reconnect
        this.connected = true;
        this.reconnectAttempts = 0;
        logger.info({ sessionId: this.sessionId, seq: this.lastSeq }, 'QQBot: Session resumed');

        // Flush queued messages
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'QQBot: Failed to flush queue')
        );
        break;

      case 'C2C_MESSAGE_CREATE':
        this.handleC2CMessage(data);
        break;

      case 'GROUP_AT_MESSAGE_CREATE':
        this.handleGroupMessage(data);
        break;

      case 'AT_MESSAGE_CREATE':
      case 'DIRECT_MESSAGE_CREATE':
        this.handleChannelMessage(data);
        break;

      default:
        logger.debug({ eventType }, 'QQBot: Unhandled event type');
    }
  }

  private handleC2CMessage(data: QQBotMessageEvent): void {
    const openid = data.author.user_openid || data.author.id;
    const jid = `c2c:${openid}`;

    // Deduplicate
    const cacheKey = `${data.id}_${data.timestamp}`;
    if (this.messageCache.has(cacheKey)) return;
    this.messageCache.add(cacheKey);
    setTimeout(() => this.messageCache.delete(cacheKey), this.CACHE_TTL);

    const timestamp = this.toUTC(data.timestamp);

    // Store metadata
    this.opts.onChatMetadata(jid, timestamp);

    // Check if registered (auto-register if callback provided)
    let group = this.opts.registeredGroups()[jid];
    if (!group) {
      if (this.opts.onAutoRegister) {
        this.opts.onAutoRegister(jid, 'c2c');
        group = this.opts.registeredGroups()[jid];
      }
      if (!group) {
        logger.info({ jid }, 'QQBot: Message from unregistered chat');
        return;
      }
    }

    // Deliver message
    this.opts.onMessage(jid, {
      id: data.id,
      chat_jid: jid,
      sender: openid,
      sender_name: openid,
      content: data.content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ jid, sender: openid }, 'QQBot: C2C message stored');
  }

  private handleGroupMessage(data: QQBotMessageEvent): void {
    const groupOpenid = data.group_openid;
    if (!groupOpenid) return;

    const jid = `group:${groupOpenid}`;
    const memberOpenid = data.author.member_openid || data.author.id;

    // Deduplicate
    const cacheKey = `${data.id}_${data.timestamp}`;
    if (this.messageCache.has(cacheKey)) return;
    this.messageCache.add(cacheKey);
    setTimeout(() => this.messageCache.delete(cacheKey), this.CACHE_TTL);

    const timestamp = this.toUTC(data.timestamp);

    // Store metadata
    this.opts.onChatMetadata(jid, timestamp);

    // Check if registered (auto-register if callback provided)
    let group = this.opts.registeredGroups()[jid];
    if (!group) {
      if (this.opts.onAutoRegister) {
        this.opts.onAutoRegister(jid, 'group');
        group = this.opts.registeredGroups()[jid];
      }
      if (!group) {
        logger.debug({ jid }, 'QQBot: Message from unregistered group');
        return;
      }
    }

    // Deliver message
    this.opts.onMessage(jid, {
      id: data.id,
      chat_jid: jid,
      sender: memberOpenid,
      sender_name: memberOpenid,
      content: data.content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ jid, sender: memberOpenid }, 'QQBot: Group message stored');
  }

  private handleChannelMessage(data: QQBotMessageEvent): void {
    const channelId = data.channel_id;
    if (!channelId) return;

    const jid = `channel:${channelId}`;
    const userId = data.author.id;

    // Deduplicate
    const cacheKey = `${data.id}_${data.timestamp}`;
    if (this.messageCache.has(cacheKey)) return;
    this.messageCache.add(cacheKey);
    setTimeout(() => this.messageCache.delete(cacheKey), this.CACHE_TTL);

    const timestamp = this.toUTC(data.timestamp);

    // Store metadata
    this.opts.onChatMetadata(jid, timestamp);

    // Check if registered (auto-register if callback provided)
    let group = this.opts.registeredGroups()[jid];
    if (!group) {
      if (this.opts.onAutoRegister) {
        this.opts.onAutoRegister(jid, 'channel');
        group = this.opts.registeredGroups()[jid];
      }
      if (!group) {
        logger.debug({ jid }, 'QQBot: Message from unregistered channel');
        return;
      }
    }

    // Deliver message
    this.opts.onMessage(jid, {
      id: data.id,
      chat_jid: jid,
      sender: userId,
      sender_name: userId,
      content: data.content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ jid, sender: userId }, 'QQBot: Channel message stored');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay = this.RECONNECT_DELAYS[
      Math.min(this.reconnectAttempts, this.RECONNECT_DELAYS.length - 1)
    ];

    logger.info({ attempt: this.reconnectAttempts + 1, delay }, 'QQBot: Scheduling reconnect');

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempts++;
      try {
        await this.connectWebSocket();
      } catch (err) {
        logger.error({ err }, 'QQBot: Reconnection failed');
      }
    }, delay);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected || !this.tokenCache) {
      this.outgoingQueue.push({ jid, text });
      logger.info({ jid, queueSize: this.outgoingQueue.length }, 'QQBot: Not connected, message queued');
      return;
    }

    try {
      const [type, id] = jid.split(':');
      let endpoint: string;
      let body: any;

      if (type === 'c2c') {
        endpoint = `/v2/users/${id}/messages`;
        body = {
          content: text,
          msg_type: 0,
          // IMPORTANT: Do NOT include msg_id - let QQ server generate it
          // Including custom msg_id causes "请求参数msg_id无效或越权" error (40034024)
        };
      } else if (type === 'group') {
        endpoint = `/v2/groups/${id}/messages`;
        body = {
          content: text,
          msg_type: 0,
          // IMPORTANT: Do NOT include msg_id - let QQ server generate it
        };
      } else {
        logger.warn({ jid }, 'QQBot: Unsupported JID type for sending');
        return;
      }

      await this.apiRequest('POST', endpoint, body);
      logger.info({ jid, length: text.length }, 'QQBot: Message sent');
    } catch (err) {
      // Queue for retry on failure
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'QQBot: Send failed, message queued');
    }
  }

  private async apiRequest(method: string, path: string, body?: any): Promise<any> {
    if (!this.tokenCache) {
      throw new Error('QQBot: Not authenticated');
    }

    const data = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: 'api.sgroup.qq.com',
      path,
      method,
      headers: {
        Authorization: `QQBot ${this.tokenCache.token}`,
        'Content-Type': 'application/json',
        ...(data && { 'Content-Length': Buffer.byteLength(data) }),
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(responseBody ? JSON.parse(responseBody) : {});
            } catch {
              resolve({});
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
          }
        });
      });

      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;

    try {
      logger.info({ count: this.outgoingQueue.length }, 'QQBot: Flushing outgoing queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendMessage(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }

  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('c2c:') || jid.startsWith('group:') || jid.startsWith('channel:');
  }

  async disconnect(): Promise<void> {
    logger.info('QQBot: Disconnecting...');

    this.connected = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info('QQBot: Disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // QQ doesn't support typing indicators
    return;
  }
}
```

### Step 3: Update Main Application

Modify `src/index.ts` to support multiple channels. Read the file first to understand the current structure.

1. **Add imports** at the top:

```typescript
import { QQBotChannel } from './channels/qqbot.js';
import { QQBOT_APP_ID, QQBOT_CLIENT_SECRET, QQBOT_SANDBOX, QQBOT_ONLY } from './config.js';
import { findChannel } from './router.js';
```

2. **Add a channels array** alongside the existing `whatsapp` variable:

```typescript
let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
```

Import `Channel` from `./types.js` if not already imported.

3. **Update `processGroupMessages`** to find the correct channel for the JID instead of using `whatsapp` directly. Replace the direct `whatsapp.setTyping()` and `whatsapp.sendMessage()` calls:

```typescript
// Find the channel that owns this JID
const channel = findChannel(channels, chatJid);
if (!channel) return true; // No channel for this JID

// ... (existing code for message fetching, trigger check, formatting)
await channel.setTyping?.(chatJid, true);

// ... (existing agent invocation)
await channel.setTyping?.(chatJid, false);
```

In the `onOutput` callback inside `processGroupMessages`, replace:

```typescript
await whatsapp.sendMessage(chatJid, `${ASSISTANT_NAME}: ${text}`);
```

with the channel-aware `formatOutbound`:

```typescript
const formatted = formatOutbound(channel, text);
if (formatted) await channel.sendMessage(chatJid, formatted);
```

4. **Update `main()` function** to create channels conditionally and use them for deps:

```typescript
async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string) =>
      storeChatMetadata(chatJid, timestamp, name),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  if (!QQBOT_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  if (QQBOT_APP_ID && QQBOT_CLIENT_SECRET) {
    const qq = new QQBotChannel(QQBOT_APP_ID, QQBOT_CLIENT_SECRET, QQBOT_SANDBOX, {
      ...channelOpts,
      onAutoRegister: (jid, type) => {
        const id = jid.split(':')[1] || jid;
        const shortId = id.slice(0, 8).toLowerCase();
        const folder = `qq-${type}-${shortId}`;
        const name = type === 'c2c' ? `QQ ${shortId}` : `QQ ${type} ${shortId}`;
        registerGroup(jid, {
          name,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: type !== 'c2c', // C2C responds to all, groups require trigger
        });
        logger.info({ jid, folder }, 'QQBot: Auto-registered chat');
      },
    });
    channels.push(qq);
    await qq.connect();
  }

  // Start subsystems
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      const text = formatOutbound(channel, rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });

  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}
```

5. **Update `getAvailableGroups`** to include QQ chats:

```typescript
export function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));
  return chats
    .filter((c) =>
      c.jid !== '__group_sync__' &&
      (c.jid.endsWith('@g.us') || c.jid.startsWith('c2c:') || c.jid.startsWith('group:') || c.jid.startsWith('channel:'))
    )
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}
```

### Step 4: Update Router

Read `src/router.ts` and ensure it has the `findChannel` function and the updated `formatOutbound`. If not, add/update them:

```typescript
import { ASSISTANT_NAME } from './config.js';

export function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((ch) => ch.ownsJid(jid));
}

export function formatOutbound(channel: Channel, rawText: string, prefix?: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  const name = prefix ?? ASSISTANT_NAME;
  const pfx = channel.prefixAssistantName !== false ? `${name}: ` : '';
  return `${pfx}${text}`;
}
```

Note: The optional `prefix` parameter allows callers to override the assistant name prefix (e.g., when the agent detects which trigger word was used). If omitted, it defaults to `ASSISTANT_NAME`.

### Step 5: Update Environment

Add to `.env`:

```bash
QQBOT_APP_ID=YOUR_APP_ID_HERE
QQBOT_CLIENT_SECRET=YOUR_CLIENT_SECRET_HERE
QQBOT_SANDBOX=false
# Optional: Set to "true" to disable WhatsApp entirely
# QQBOT_ONLY=true
```

**Important**: After modifying `.env`, sync to the container environment:

```bash
mkdir -p data/env
cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

**CRITICAL**: If using systemd or a start script with `sg docker`, you must ensure environment variables are loaded properly:

Update `start.sh` to load `.env` variables before the `sg` command:

```bash
#!/bin/bash
# NanoClaw startup wrapper with docker group access

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"

# Load environment variables from .env file and pass them through sg
if [ -f "$PROJECT_DIR/.env" ]; then
  # Read .env and export each variable properly (handles special characters)
  set -a
  source "$PROJECT_DIR/.env"
  set +a
  exec sg docker -c "exec $NODE_BIN $PROJECT_DIR/dist/index.js"
else
  exec sg docker -c "exec $NODE_BIN $PROJECT_DIR/dist/index.js"
fi
```

Using `set -a; source .env; set +a` is more robust than `grep | xargs` — it correctly handles values with special characters (spaces, quotes, etc.). The exported variables are inherited by the `sg docker` subshell.

### Step 6: Auto-Registration

QQ chats are automatically registered when the first message arrives. No manual registration needed.

- **C2C (private)**: Auto-registered with `requiresTrigger: false` (responds to all messages)
- **Group**: Auto-registered with `requiresTrigger: true` (requires @mention)
- **Channel**: Auto-registered with `requiresTrigger: true`

Folder naming: `qq-{type}-{first 8 chars of OpenID}` (e.g., `qq-c2c-5548dc0b`)

The `onAutoRegister` callback in `index.ts` calls `registerGroup()` which creates the group folder and persists to the database. The message is then delivered normally without needing a restart.

**Optional**: A manual registration tool at `src/channels/register-qqbot.ts` is also available for advanced use (e.g., customizing folder names or trigger patterns):

```bash
npx tsx src/channels/register-qqbot.ts
```

### Step 7: Build and Restart

```bash
npm run build
```

Then restart the service using your platform's service manager:

```bash
# Linux (systemd)
systemctl --user restart nanoclaw

# macOS (launchctl)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 8: Test

Tell the user:

> Send a message to your QQ bot. The chat will be auto-registered on first message — no manual setup needed.
> - C2C (private): Responds immediately to all messages
> - Groups: Requires @mention after auto-registration
>
> Check logs: `tail -f logs/nanoclaw.log`

## Replace WhatsApp Entirely

If user wants QQ-only:

1. Set `QQBOT_ONLY=true` in `.env`
2. Run `cp .env data/env/env` to sync to container
3. The WhatsApp channel is not created — only QQ
4. All services (scheduler, IPC watcher, queue, message loop) start normally
5. Optionally remove `@whiskeysockets/baileys` dependency (but it's harmless to keep)

## Features

### Chat ID Formats

- **WhatsApp**: `120363336345536173@g.us` (groups) or `1234567890@s.whatsapp.net` (DM)
- **QQ**:
  - `c2c:{openid}` - Private messages (32-char hex OpenID)
  - `group:{groupOpenid}` - Group messages (32-char hex OpenID)
  - `channel:{channelId}` - Channel messages

### Trigger Options

The bot responds when:
1. Chat has `requiresTrigger: false` in its registration (e.g., main group)
2. Message matches TRIGGER_PATTERN (e.g., starts with `@yourbot`)

### @mention Behavior

In QQ groups, the bot will only see messages that @mention it directly. This is enforced by QQ's API - you don't need to configure anything.

### Connection Mechanism

- **WebSocket Gateway**: Persistent connection to QQ's servers
- **No Public IP**: Client-initiated connection (outbound)
- **Session Resume**: Reconnects preserve message sequence
- **Heartbeat**: Keeps connection alive (configurable interval from server)
- **Token Refresh**: Automatic refresh 5 minutes before expiry
- **Message Queue**: Failed messages are queued and retried on reconnect

## Troubleshooting

### Critical Fixes (Verified Solutions)

#### 1. Environment Variables Not Loading

**Problem**: QQ credentials not being read, service fails to connect.

**Solution**: Update `start.sh` to properly load `.env` before `sg docker`:

```bash
#!/bin/bash
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
  exec sg docker -c "exec $NODE_BIN $PROJECT_DIR/dist/index.js"
else
  exec sg docker -c "exec $NODE_BIN $PROJECT_DIR/dist/index.js"
fi
```

Using `set -a; source .env; set +a` correctly handles values with special characters. The exported variables are inherited by the `sg docker` subshell.

#### 2. Message Send Failure: "请求参数msg_id无效或越权" (Error 40034024)

**Problem**: Bot receives messages but fails to send replies with HTTP 400 error.

**Solution**: Do NOT include `msg_id` in the message body. Let QQ server generate it automatically.

**Wrong**:
```typescript
body = {
  content: text,
  msg_type: 0,
  msg_id: Date.now().toString(),  // ❌ Causes error 40034024
};
```

**Correct**:
```typescript
body = {
  content: text,
  msg_type: 0,
  // ✓ No msg_id - server generates it
};
```

#### 3. Unregistered Messages Not Visible in Logs

**Problem**: Messages arrive but you can't see "Message from unregistered chat" logs.

**Solution**: Change `logger.debug` to `logger.info` in message handlers:

```typescript
if (!group) {
  logger.info({ jid }, 'QQBot: Message from unregistered chat');  // ✓ Use info, not debug
  return;
}
```

Debug logs may not appear in production output.

#### 4. Database Column Name Mismatch

**Problem**: Registration script fails with "no column named trigger".

**Solution**: Use correct column name `trigger_pattern` (not `trigger`):

```javascript
const stmt = db.prepare(`
  INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
  VALUES (?, ?, ?, ?, ?, ?)
`);
```

#### 5. Reconnection Not Resuming Message Sending (RESUMED Event)

**Problem**: After QQ reconnects, it receives a RESUMED event but doesn't handle it, causing the `connected` state not to be updated. Messages get queued but can't be sent.

**Solution**: Add RESUMED event handling in `handleDispatch`:

```typescript
case 'RESUMED':
  // Session resumed successfully after reconnect
  this.connected = true;
  this.reconnectAttempts = 0;
  logger.info({ sessionId: this.sessionId, seq: this.lastSeq }, 'QQBot: Session resumed');

  // Flush queued messages
  this.flushOutgoingQueue().catch((err) =>
    logger.error({ err }, 'QQBot: Failed to flush queue')
  );
  break;
```

**Impact**: After the fix, QQ reconnection properly resumes message sending functionality. Without this, messages would queue indefinitely after a reconnect.

#### 6. Timestamp Timezone Mismatch

**Problem**: QQ returns timestamps with a timezone offset (e.g., `+08:00`), but the database uses string comparison for ordering. Messages from QQ and WhatsApp may sort incorrectly because their timestamp formats differ.

**Solution**: Normalize all QQ timestamps to UTC before storing. Add a `toUTC` helper to `QQBotChannel`:

```typescript
/** Convert any ISO timestamp to UTC (Z suffix) for consistent DB ordering */
private toUTC(ts: string): string {
  return new Date(ts).toISOString();
}
```

Call `this.toUTC(data.timestamp)` in all message handlers (`handleC2CMessage`, `handleGroupMessage`, `handleChannelMessage`) before passing the timestamp to `onChatMetadata` and `onMessage`.

**Impact**: Without this fix, messages from different timezones may appear out of order in the database, causing the message loop to miss or re-process messages.

### Bot not connecting

Check:
1. `QQBOT_APP_ID` and `QQBOT_CLIENT_SECRET` are set in `.env` AND synced to `data/env/env`
2. QQ Open Platform credentials are correct
3. Network connectivity to QQ API (`bots.qq.com` and `api.sgroup.qq.com`)
4. Service is running: `systemctl --user status nanoclaw` (Linux) or `launchctl list | grep nanoclaw` (macOS)
5. Logs: `tail -f logs/nanoclaw.log`

### Authentication failures

1. Verify AppID and ClientSecret from QQ Open Platform
2. Check if bot is approved (sandbox mode has limitations)
3. Look for error messages in logs: `grep "QQ:" logs/nanoclaw.log`

### Bot not responding in groups

1. QQ bots require explicit @mention in groups (API limitation)
2. Ensure the group is registered: Check `store/messages.db` → `registered_groups` table
3. Verify `requiresTrigger` setting matches your expectation
4. Check if bot has permission to read group messages in QQ Open Platform settings

### Messages not being received

1. Check WebSocket connection status in logs: `grep "QQ: Ready" logs/nanoclaw.log`
2. Verify intents are correct (C2C, GROUP_AT, AT messages)
3. Ensure OpenID is correct in registration
4. Test with a simple message and check logs for "unregistered chat" messages

### Token expiration issues

1. Token should auto-refresh 5 minutes before expiry
2. Check logs for "QQ: Refreshing token" messages
3. If refresh fails, bot will reconnect and re-authenticate
4. Verify ClientSecret hasn't changed in QQ Open Platform

### Service conflicts

If running `npm run dev` while the background service is active:

```bash
# Linux (systemd)
systemctl --user stop nanoclaw
npm run dev
# When done testing:
systemctl --user start nanoclaw

# macOS (launchctl)
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### WebSocket keeps disconnecting

1. Check network stability
2. Verify heartbeat is working: `grep "heartbeat" logs/nanoclaw.log`
3. Look for "Invalid session" or "Reconnect" messages
4. Session resume should handle temporary disconnects automatically

## Removal

To remove QQ integration:

1. Delete `src/channels/qqbot.ts`
2. Remove `QQBotChannel` import and creation from `src/index.ts`
3. Remove `channels` array and revert to using `whatsapp` directly in `processGroupMessages`, scheduler deps, and IPC deps
4. Revert `getAvailableGroups()` filter to only include `@g.us` chats
5. Remove QQBot config (`QQBOT_APP_ID`, `QQBOT_CLIENT_SECRET`, `QQBOT_SANDBOX`, `QQBOT_ONLY`) from `src/config.ts`
6. Remove QQ registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'c2c:%' OR jid LIKE 'group:%' OR jid LIKE 'channel:%'"`
7. Uninstall: `npm uninstall ws @types/ws`
8. Rebuild and restart: `npm run build` then restart your service

## Technical Notes

### WebSocket Protocol

QQ uses a custom WebSocket protocol with operation codes (opcodes):

- `op: 0` - Dispatch (events like messages, READY)
- `op: 1` - Heartbeat (client → server)
- `op: 2` - Identify (initial authentication)
- `op: 6` - Resume (reconnect with session)
- `op: 7` - Reconnect (server requests reconnect)
- `op: 9` - Invalid Session (need to re-identify)
- `op: 10` - Hello (server sends heartbeat interval)
- `op: 11` - Heartbeat ACK (server confirms heartbeat)

### Event Types

- `READY` - Connection established, session ID received
- `C2C_MESSAGE_CREATE` - Private message
- `GROUP_AT_MESSAGE_CREATE` - Group @mention
- `AT_MESSAGE_CREATE` - Channel @mention
- `DIRECT_MESSAGE_CREATE` - Channel DM

### API Endpoints

- **Auth**: `POST https://bots.qq.com/app/getAppAccessToken`
- **Gateway**: `GET https://api.sgroup.qq.com/gateway`
- **Send C2C**: `POST https://api.sgroup.qq.com/v2/users/{openid}/messages`
- **Send Group**: `POST https://api.sgroup.qq.com/v2/groups/{groupOpenid}/messages`

### Intents

The implementation uses these intents:
- `1 << 30` - C2C messages
- `1 << 25` - Group @mentions
- `1 << 12` - Channel @mentions

Combined: `0 | (1 << 30) | (1 << 25) | (1 << 12)`

## Comparison with Original Implementation

This implementation is based on the verified [@sliverp/qqbot](https://github.com/sliverp/qqbot) project and includes:
✅ Full WebSocket protocol handling (opcodes, heartbeat, session resume)
✅ Token auto-refresh with jitter to prevent thundering herd
✅ Message queue for failed sends
✅ Message deduplication
✅ Exponential backoff reconnection
✅ Session resume to prevent message loss
✅ Proper event type handling

This ensures reliable operation without public IP requirements.