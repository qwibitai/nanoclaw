import http from 'node:http';
import {
  BotFrameworkAdapter,
  TurnContext,
  type ConversationReference,
  ActivityTypes,
} from 'botbuilder';
import { registerChannel, type ChannelOpts } from './registry.js';
import type { Channel, NewMessage } from '../types.js';
import { readEnvFile } from '../env.js';

const JID_PREFIX = 'teams:';

function makeJid(conversationId: string): string {
  return `${JID_PREFIX}${encodeURIComponent(conversationId)}`;
}

function conversationIdFromJid(jid: string): string {
  return decodeURIComponent(jid.slice(JID_PREFIX.length));
}

/** Strip <at>BotName</at> mentions that Teams injects into group messages. */
function stripMentions(text: string): string {
  return text.replace(/<at>[^<]*<\/at>/g, '').trim();
}

class TeamsChannel implements Channel {
  readonly name = 'teams';

  private adapter: BotFrameworkAdapter;
  private server: http.Server | null = null;
  private connected = false;
  private refs = new Map<string, Partial<ConversationReference>>();
  private opts: ChannelOpts;
  private port: number;

  constructor(
    appId: string,
    appPassword: string,
    tenantId: string,
    port: number,
    opts: ChannelOpts,
  ) {
    this.port = port;
    this.opts = opts;

    this.adapter = new BotFrameworkAdapter({
      appId,
      appPassword,
      channelAuthTenant: tenantId || 'botframework.com',
    });

    this.adapter.onTurnError = async (_ctx, err) => {
      console.error('[teams] Turn error:', err);
    };
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/messages') {
        // BotFrameworkAdapter expects an Express-style response with send/status.
        const webRes = {
          socket: res.socket,
          send(body?: unknown) {
            if (body != null) res.write(typeof body === 'string' ? body : JSON.stringify(body));
            res.end();
            return this;
          },
          status(code: number) {
            res.statusCode = code;
            return this;
          },
          end() { res.end(); return this; },
        };
        this.adapter.processActivity(req, webRes as any, (ctx) =>
          this.handleTurn(ctx),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        console.log(`[teams] Webhook listening on port ${this.port}`);
        this.connected = true;
        resolve();
      });
    });
  }

  private async handleTurn(ctx: TurnContext): Promise<void> {
if (ctx.activity.type !== ActivityTypes.Message) return;

    const activity = ctx.activity;
    const conversationId = activity.conversation.id;
    const jid = makeJid(conversationId);

    // Persist conversation reference so we can reply proactively later.
    this.refs.set(jid, TurnContext.getConversationReference(activity));

    const isGroup = activity.conversation.isGroup ?? false;
    const chatName = activity.conversation.name ?? conversationId;
    this.opts.onChatMetadata(
      jid,
      activity.timestamp?.toISOString() ?? new Date().toISOString(),
      chatName,
      'teams',
      isGroup,
    );

    const content = stripMentions(activity.text ?? '');
    if (!content) return;

    const msg: NewMessage = {
      id: activity.id ?? `teams-${Date.now()}`,
      chat_jid: jid,
      sender: `teams:${activity.from.id}`,
      sender_name: activity.from.name ?? activity.from.id,
      content,
      timestamp: activity.timestamp?.toISOString() ?? new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    };

    this.opts.onMessage(jid, msg);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const ref = this.refs.get(jid);
    if (!ref) {
      const id = conversationIdFromJid(jid);
      console.error(
        `[teams] No conversation reference for ${id} — message dropped`,
      );
      return;
    }
    await this.adapter.continueConversation(ref, async (ctx) => {
      await ctx.sendActivity(text);
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

registerChannel('teams', (opts: ChannelOpts) => {
  const env = readEnvFile(['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_TENANT_ID', 'TEAMS_PORT']);
  const appId = env.TEAMS_APP_ID;
  const appPassword = env.TEAMS_APP_PASSWORD;
  if (!appId || !appPassword) return null;
  const tenantId = env.TEAMS_TENANT_ID ?? 'botframework.com';
  const port = parseInt(env.TEAMS_PORT ?? '3978', 10);
  return new TeamsChannel(appId, appPassword, tenantId, port, opts);
});
