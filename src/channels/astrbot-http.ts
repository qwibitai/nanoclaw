import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { cacheAttachmentsForMessage } from '../attachment-cache.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { registerChannel } from './registry.js';

interface AstrBotInboundPayload {
  chat_id: string;
  umo?: string;
  sender_id?: string;
  sender_name?: string;
  sender_nickname?: string;
  sender_username?: string;
  sender_card?: string;
  content: string;
  timestamp?: string;
  is_group?: boolean;
  group_name?: string;
  group_id?: string;
  is_bot?: boolean;
  is_from_me?: boolean;
  message_id?: string;
  platform_name?: string;
  platform_id?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
}

interface AstrBotControlPayload {
  action: 'set_main' | 'reset_session' | 'diag';
  chat_id?: string;
  umo?: string;
  group_name?: string;
  sender_name?: string;
}

interface AstrBotConfig {
  listenHost: string;
  listenPort: number;
  token?: string;
  apiBase: string;
  apiKey?: string;
}

interface AstrBotOutboundPayload {
  chat_id: string;
  umo?: string;
  text: string;
}

function getConfig(): AstrBotConfig {
  const env = readEnvFile([
    'ASTRBOT_HTTP_HOST',
    'ASTRBOT_HTTP_PORT',
    'ASTRBOT_HTTP_TOKEN',
    'ASTRBOT_API_BASE',
    'ASTRBOT_API_KEY',
  ]);
  const fromEnv = (key: keyof typeof env) => process.env[key] || env[key];

  return {
    listenHost: fromEnv('ASTRBOT_HTTP_HOST') || '127.0.0.1',
    listenPort: parseInt(fromEnv('ASTRBOT_HTTP_PORT') || '7801', 10),
    token: fromEnv('ASTRBOT_HTTP_TOKEN'),
    apiBase: (fromEnv('ASTRBOT_API_BASE') || 'http://127.0.0.1:6185').replace(
      /\/$/,
      '',
    ),
    apiKey: fromEnv('ASTRBOT_API_KEY'),
  };
}

function readBody(
  req: IncomingMessage,
  limitBytes = 1024 * 1024,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function makeMessageId(): string {
  return `astrbot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function deriveFolder(chatJid: string): string {
  const hash = createHash('sha1').update(chatJid).digest('hex').slice(0, 12);
  return `astrbot_${hash}`;
}

function ensureMainClaudeTemplate(folder: string): void {
  const templatePath = path.join(process.cwd(), 'groups', 'main', 'CLAUDE.md');
  if (!fs.existsSync(templatePath)) return;

  const destPath = path.join(resolveGroupFolderPath(folder), 'CLAUDE.md');
  if (fs.existsSync(destPath)) return;

  fs.copyFileSync(templatePath, destPath);
}

function validatePayload(payload: any): payload is AstrBotInboundPayload {
  return (
    payload &&
    typeof payload === 'object' &&
    typeof payload.chat_id === 'string' &&
    typeof payload.content === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function makeOutboundHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function getMainGroupEntry(
  groups: Record<string, RegisteredGroup>,
): [string, RegisteredGroup] | undefined {
  return Object.entries(groups).find(([, group]) => group.isMain);
}

function getModelDiagnostics(): Record<string, unknown> {
  const env = readEnvFile([
    'NANOCLAW_MODEL',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  const model = process.env.NANOCLAW_MODEL || env.NANOCLAW_MODEL || null;
  const anthropicBaseUrl =
    process.env.ANTHROPIC_BASE_URL ||
    env.ANTHROPIC_BASE_URL ||
    'https://api.anthropic.com';
  const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY);
  const hasOauthToken = !!(
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    env.CLAUDE_CODE_OAUTH_TOKEN ||
    env.ANTHROPIC_AUTH_TOKEN
  );

  return {
    model,
    anthropicBaseUrl,
    authMode: hasApiKey ? 'api-key' : 'oauth',
    apiKeyConfigured: hasApiKey,
    oauthConfigured: hasOauthToken,
  };
}

function buildDiagPayload(
  groups: Record<string, RegisteredGroup>,
  connected: boolean,
  config: AstrBotConfig,
): Record<string, unknown> {
  const mainEntry = getMainGroupEntry(groups);
  return {
    ok: true,
    main: mainEntry
      ? {
          jid: mainEntry[0],
          name: mainEntry[1].name,
          folder: mainEntry[1].folder,
          trigger: mainEntry[1].trigger,
        }
      : null,
    diag: {
      channel: {
        connected,
        listenHost: config.listenHost,
        listenPort: config.listenPort,
        tokenConfigured: !!config.token,
      },
      openapi: {
        apiBase: config.apiBase,
        apiKeyConfigured: !!config.apiKey,
      },
      sessions: {
        registeredCount: Object.keys(groups).length,
      },
      model: getModelDiagnostics(),
    },
  };
}

function buildAstrBotMetadata(
  inbound: AstrBotInboundPayload,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = isRecord(inbound.metadata)
    ? { ...inbound.metadata }
    : {};

  metadata.source = 'astrbot';
  if (inbound.umo) metadata.umo = inbound.umo;
  if (inbound.platform_name) metadata.platform_name = inbound.platform_name;
  if (inbound.platform_id) metadata.platform_id = inbound.platform_id;
  if (inbound.session_id) metadata.session_id = inbound.session_id;
  if (inbound.chat_id) metadata.chat_id = inbound.chat_id;
  if (inbound.group_id) metadata.group_id = inbound.group_id;
  if (inbound.group_name) metadata.group_name = inbound.group_name;
  if (inbound.is_group !== undefined) metadata.is_group = inbound.is_group;

  const senderProfile: Record<string, unknown> = isRecord(
    metadata.sender_profile,
  )
    ? { ...metadata.sender_profile }
    : {};
  if (inbound.sender_nickname) senderProfile.nickname = inbound.sender_nickname;
  if (inbound.sender_username) senderProfile.username = inbound.sender_username;
  if (inbound.sender_card) senderProfile.card = inbound.sender_card;
  if (Object.keys(senderProfile).length > 0) {
    metadata.sender_profile = senderProfile;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

class AstrBotHttpChannel implements Channel {
  public name = 'astrbot-http';
  private server: Server | null = null;
  private connected = false;
  private readonly config: AstrBotConfig;
  private readonly onMessage: (chatJid: string, msg: NewMessage) => void;
  private readonly onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  private readonly registeredGroups: () => Record<string, RegisteredGroup>;
  private readonly registerGroup: (jid: string, group: RegisteredGroup) => void;
  private readonly setMainGroup: (jid: string, group: RegisteredGroup) => void;
  private readonly resetSession: (jid: string) => {
    ok: boolean;
    error?: string;
  };
  private readonly defaultTrigger: string;
  private readonly umoByJid = new Map<string, string>();

  constructor(
    onMessage: (chatJid: string, msg: NewMessage) => void,
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => void,
    registeredGroups: () => Record<string, RegisteredGroup>,
    registerGroup: (jid: string, group: RegisteredGroup) => void,
    setMainGroup: (jid: string, group: RegisteredGroup) => void,
    resetSession: (jid: string) => { ok: boolean; error?: string },
    defaultTrigger: string,
  ) {
    this.onMessage = onMessage;
    this.onChatMetadata = onChatMetadata;
    this.registeredGroups = registeredGroups;
    this.registerGroup = registerGroup;
    this.setMainGroup = setMainGroup;
    this.resetSession = resetSession;
    this.defaultTrigger = defaultTrigger;
    this.config = getConfig();
  }

  async connect(): Promise<void> {
    if (this.server) return;

    this.server = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (
        req.method !== 'POST' ||
        (req.url !== '/astrbot/inbound' && req.url !== '/astrbot/control')
      ) {
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }

      if (this.config.token) {
        const auth = req.headers['authorization'] || '';
        const bearer = Array.isArray(auth) ? auth[0] : auth;
        const token = bearer.startsWith('Bearer ')
          ? bearer.slice('Bearer '.length)
          : '';
        const alt = req.headers['x-astrbot-token'];
        const headerToken = Array.isArray(alt) ? alt[0] : alt;
        if (token !== this.config.token && headerToken !== this.config.token) {
          sendJson(res, 401, { ok: false, error: 'Unauthorized' });
          return;
        }
      }

      let bodyText = '';
      try {
        bodyText = await readBody(req);
      } catch (err) {
        logger.warn({ err }, 'AstrBot inbound body read failed');
        sendJson(res, 413, { ok: false, error: 'Payload too large' });
        return;
      }

      let payload: AstrBotInboundPayload | AstrBotControlPayload;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
        return;
      }

      if (req.url === '/astrbot/control') {
        const ctl = payload as AstrBotControlPayload;
        if (ctl.action === 'reset_session') {
          if (typeof ctl.chat_id !== 'string') {
            sendJson(res, 400, { ok: false, error: 'Invalid control payload' });
            return;
          }
          const chatJid = `astrbot:${ctl.chat_id}`;
          const result = this.resetSession(chatJid);
          if (!result.ok) {
            sendJson(res, 404, {
              ok: false,
              error: result.error || 'Not found',
            });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (ctl.action === 'diag') {
          const groups = this.registeredGroups();
          sendJson(
            res,
            200,
            buildDiagPayload(groups, this.connected, this.config),
          );
          return;
        }
        if (ctl.action !== 'set_main' || typeof ctl.chat_id !== 'string') {
          sendJson(res, 400, { ok: false, error: 'Invalid control payload' });
          return;
        }
        const chatJid = `astrbot:${ctl.chat_id}`;
        if (ctl.umo) this.umoByJid.set(chatJid, ctl.umo);
        const folder = deriveFolder(chatJid);
        const name =
          ctl.group_name || ctl.sender_name || `AstrBot ${ctl.chat_id}`;
        try {
          ensureMainClaudeTemplate(folder);
        } catch (err) {
          logger.warn(
            { chatJid, folder, err },
            'Failed to copy AstrBot main CLAUDE.md template',
          );
        }
        this.setMainGroup(chatJid, {
          name,
          folder,
          trigger: this.defaultTrigger,
          added_at: new Date().toISOString(),
        });
        sendJson(res, 200, { ok: true, main_jid: chatJid });
        return;
      }

      if (!validatePayload(payload)) {
        sendJson(res, 400, { ok: false, error: 'Missing required fields' });
        return;
      }

      const inbound = payload as AstrBotInboundPayload;
      const chatJid = `astrbot:${inbound.chat_id}`;
      if (inbound.umo) this.umoByJid.set(chatJid, inbound.umo);

      const timestamp = inbound.timestamp || new Date().toISOString();
      const senderName =
        inbound.sender_name ||
        inbound.sender_nickname ||
        inbound.sender_username ||
        inbound.sender_card ||
        inbound.sender_id ||
        'unknown';
      const senderId = inbound.sender_id || senderName;

      const msg: NewMessage = {
        id: inbound.message_id || makeMessageId(),
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content: inbound.content,
        timestamp,
        is_from_me: inbound.is_from_me || false,
        is_bot_message: inbound.is_bot || false,
        metadata: buildAstrBotMetadata(inbound),
      };

      const groupName = inbound.group_name || inbound.group_id || senderName;
      this.onChatMetadata(
        chatJid,
        timestamp,
        groupName,
        this.name,
        inbound.is_group ?? false,
      );

      // Auto-register chat if missing
      if (!this.registeredGroups()[chatJid]) {
        const folder = deriveFolder(chatJid);
        this.registerGroup(chatJid, {
          name: groupName,
          folder,
          trigger: this.defaultTrigger,
          added_at: new Date().toISOString(),
          requiresTrigger: inbound.is_group ?? false,
        });
      }

      const groupFolder =
        this.registeredGroups()[chatJid]?.folder || deriveFolder(chatJid);
      try {
        const cacheResult = await cacheAttachmentsForMessage({
          groupDir: resolveGroupFolderPath(groupFolder),
          metadata: msg.metadata,
          messageId: msg.id,
          content: msg.content,
        });
        if (cacheResult.metadata) {
          msg.metadata = cacheResult.metadata;
        }
        if (cacheResult.synthesizedContent) {
          msg.content = cacheResult.synthesizedContent;
        }
      } catch (err) {
        logger.warn(
          { err, chatJid, messageId: msg.id },
          'Attachment caching failed',
        );
      }

      this.onMessage(chatJid, msg);

      sendJson(res, 200, { ok: true });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.listenPort, this.config.listenHost, () =>
        resolve(),
      );
      this.server!.on('error', reject);
    });

    this.connected = true;
    logger.info(
      { host: this.config.listenHost, port: this.config.listenPort },
      'AstrBot HTTP channel listening',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const umo = this.umoByJid.get(jid);
    const chatId = jid.startsWith('astrbot:')
      ? jid.slice('astrbot:'.length)
      : jid;
    if (!chatId) {
      logger.warn({ jid }, 'AstrBot chat id missing for jid, cannot send');
      return;
    }

    const outboundPayload: AstrBotOutboundPayload = {
      chat_id: chatId,
      umo,
      text,
    };
    const outboundUrl = `${this.config.apiBase}/api/plug/nanoclaw_bridge/outbound`;
    const outboundRes = await fetch(outboundUrl, {
      method: 'POST',
      headers: makeOutboundHeaders(this.config.token),
      body: JSON.stringify(outboundPayload),
    }).catch((err) => {
      logger.warn({ err, jid }, 'AstrBot plugin outbound request failed');
      return null;
    });

    if (outboundRes?.ok) {
      return;
    }
    if (outboundRes) {
      const errText = await outboundRes.text().catch(() => '');
      logger.warn(
        { status: outboundRes.status, body: errText, jid },
        'AstrBot plugin outbound rejected message, falling back to OpenAPI',
      );
    }

    if (!umo) {
      logger.warn(
        { jid },
        'AstrBot UMO missing for jid, cannot use OpenAPI fallback',
      );
      return;
    }
    if (!this.config.apiKey) {
      logger.warn(
        'ASTRBOT_API_KEY not set; cannot use AstrBot OpenAPI fallback',
      );
      return;
    }

    const fallbackUrl = `${this.config.apiBase}/api/v1/im/message`;
    const fallbackRes = await fetch(fallbackUrl, {
      method: 'POST',
      headers: {
        ...makeOutboundHeaders(),
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ umo, message: text }),
    });

    if (!fallbackRes.ok) {
      const errText = await fallbackRes.text().catch(() => '');
      logger.warn(
        { status: fallbackRes.status, body: errText },
        'AstrBot outbound OpenAPI fallback failed',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('astrbot:');
  }

  async disconnect(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    this.connected = false;
  }
}

registerChannel('astrbot-http', (opts) => {
  return new AstrBotHttpChannel(
    opts.onMessage,
    opts.onChatMetadata,
    opts.registeredGroups,
    opts.registerGroup,
    opts.setMainGroup,
    opts.resetSession,
    opts.defaultTrigger,
  );
});

export const _astrbotHttpInternals = {
  buildDiagPayload,
  ensureMainClaudeTemplate,
};
