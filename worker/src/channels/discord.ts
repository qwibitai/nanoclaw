/**
 * ThagomizerClaw — Discord Channel Webhook Handler
 *
 * Handles Discord Interactions (slash commands + message events via webhook).
 * Discord requires Ed25519 signature verification for all webhook requests.
 *
 * Setup:
 *   1. Create app at https://discord.com/developers/applications
 *   2. Get bot token (DISCORD_BOT_TOKEN) and public key (DISCORD_PUBLIC_KEY)
 *   3. Run: wrangler secret put DISCORD_BOT_TOKEN
 *          wrangler secret put DISCORD_PUBLIC_KEY
 *   4. Set interactions endpoint URL to: https://your-worker.workers.dev/webhook/discord
 */

import type { Env, NewMessage, ParsedWebhookEvent } from '../types.js';

interface DiscordInteraction {
  id: string;
  type: number; // 1=PING, 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT
  data?: {
    name?: string;
    options?: Array<{ name: string; value: string }>;
    content?: string;
  };
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser; nick?: string };
  user?: DiscordUser;
  token: string;
  message?: DiscordMessage;
}

interface DiscordMessage {
  id: string;
  content: string;
  author: DiscordUser;
  timestamp: string;
  channel_id: string;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string;
  bot?: boolean;
}

export function buildDiscordJid(channelId: string, guildId?: string): string {
  return guildId ? `dc:${guildId}:${channelId}` : `dc:dm:${channelId}`;
}

export function ownsDiscordJid(jid: string): boolean {
  return jid.startsWith('dc:');
}

/**
 * Verify Discord webhook request signature using Ed25519.
 * Required by Discord — requests fail without this.
 */
export async function verifyDiscordSignature(
  request: Request,
  body: string,
  env: Env,
): Promise<boolean> {
  if (!env.DISCORD_PUBLIC_KEY) return false;

  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');

  if (!signature || !timestamp) return false;

  try {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      hexToBytes(env.DISCORD_PUBLIC_KEY),
      { name: 'Ed25519', namedCurve: 'Ed25519' },
      false,
      ['verify'],
    );

    const message = new TextEncoder().encode(timestamp + body);
    const sig = hexToBytes(signature);

    return crypto.subtle.verify('Ed25519', publicKey, sig, message);
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Parse a Discord interaction into a normalized message.
 */
export function parseDiscordInteraction(
  interaction: DiscordInteraction,
): ParsedWebhookEvent | null {
  // Handle PING (Discord health check)
  if (interaction.type === 1) {
    return null; // Caller should return {"type": 1} PONG response
  }

  const channelId = interaction.channel_id;
  if (!channelId) return null;

  const chatJid = buildDiscordJid(channelId, interaction.guild_id);
  const user = interaction.member?.user ?? interaction.user;
  if (!user) return null;

  // Extract message content from slash command or message component
  let content = '';
  if (interaction.type === 2 && interaction.data?.name === 'ask') {
    const option = interaction.data.options?.find((o) => o.name === 'message');
    content = option?.value ?? '';
  } else if (interaction.message?.content) {
    content = interaction.message.content;
  }

  if (!content) return null;

  const senderName = user.global_name ?? user.username;
  const message: NewMessage = {
    id: `dc_${interaction.id}`,
    chat_jid: chatJid,
    sender: `dc:${user.id}`,
    sender_name: senderName,
    content,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: user.bot ?? false,
    channel: 'discord',
  };

  return {
    chatJid,
    message,
    channel: 'discord',
  };
}

/**
 * Send a Discord message via Bot API.
 */
export async function sendDiscordMessage(
  channelId: string,
  text: string,
  env: Env,
): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN) {
    throw new Error('DISCORD_BOT_TOKEN not configured');
  }

  // Discord has a 2000 char limit
  const chunks = splitMessage(text, 2000);

  for (const chunk of chunks) {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: chunk }),
      },
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Discord send failed: ${err}`);
    }
  }
}

export function parseDiscordChannelFromJid(jid: string): string | null {
  // dc:{guildId}:{channelId} or dc:dm:{channelId}
  const parts = jid.split(':');
  return parts.length >= 3 ? parts[parts.length - 1] : null;
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, maxLen);
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline > maxLen * 0.8) chunk = chunk.slice(0, lastNewline);
    chunks.push(chunk.trim());
    remaining = remaining.slice(chunk.length).trim();
  }
  return chunks;
}
