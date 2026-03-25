// irc.ts — IRC channel adapter for NanoClaw
// Connects to Ergo IRC server via TLS, uses NickServ auth.
// Self-registers as 'irc' channel.

import * as tls from 'tls';
import * as net from 'net';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type { Channel, NewMessage } from '../types.js';

import { registerChannel } from './registry.js';
import type { ChannelOpts } from './registry.js';

const IRC_MAX_LINE = 400;

// All known bot nicks (for metadata — NanoClaw's own trigger logic handles routing)
const BOT_NICKS = new Set([
  'db-bot',
  'nook-bot',
  'mbot',
  'matterbridge',
  'matterbridge_',
]);

interface IRCConfig {
  host: string;
  port: number;
  useTls: boolean;
  nick: string;
  password: string;
  channels: string[];
}

function loadIRCConfig(): IRCConfig | null {
  const env = readEnvFile([
    'IRC_HOST',
    'IRC_PORT',
    'IRC_TLS',
    'IRC_NICK',
    'IRC_PASSWORD',
    'IRC_CHANNELS',
  ]);

  const host = env.IRC_HOST;
  if (!host) {
    logger.info('IRC_HOST not set — skipping IRC channel');
    return null;
  }

  return {
    host,
    port: parseInt(env.IRC_PORT || '6697', 10),
    useTls: env.IRC_TLS !== 'false',
    nick: env.IRC_NICK || 'x-bot',
    password: env.IRC_PASSWORD || '',
    channels: (env.IRC_CHANNELS || '#public,#coord')
      .split(',')
      .map((c) => c.trim()),
  };
}

export function createIRCChannel(opts: ChannelOpts): Channel | null {
  const maybeConfig = loadIRCConfig();
  if (!maybeConfig) return null;
  const config: IRCConfig = maybeConfig;

  let socket: tls.TLSSocket | net.Socket | null = null;
  let connected = false;
  let buffer = '';
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let shouldReconnect = true;

  // Turn-taking state
  let lastResponseTime: Record<string, number> = {};
  let depthCounter: Record<string, number> = {};
  const COOLDOWN_MS = 3000;
  const MAX_DEPTH = 10;

  function send(line: string): void {
    if (socket && !socket.destroyed) {
      socket.write(line + '\r\n');
    }
  }

  function resetTurnTaking(channel: string): void {
    depthCounter[channel] = 0;
  }

  function recordBotMessage(channel: string): void {
    depthCounter[channel] = (depthCounter[channel] || 0) + 1;
  }

  function canRespond(channel: string): boolean {
    const now = Date.now();
    const last = lastResponseTime[channel] || 0;
    if (now - last < COOLDOWN_MS) return false;
    if ((depthCounter[channel] || 0) >= MAX_DEPTH) return false;
    return true;
  }

  function recordResponse(channel: string): void {
    lastResponseTime[channel] = Date.now();
    recordBotMessage(channel);
  }

  function parseLine(raw: string): void {
    if (raw.startsWith('PING')) {
      send('PONG' + raw.slice(4));
      return;
    }

    if (!raw.startsWith(':')) return;

    const parts = raw.slice(1).split(' ');
    if (parts.length < 2) return;

    const prefix = parts[0];
    const command = parts[1];

    // Handle 001 (welcome) — send NickServ IDENTIFY + JOIN
    if (command === '001') {
      logger.info({ nick: config.nick }, 'IRC connected');
      if (config.password) {
        send(`PRIVMSG NickServ :IDENTIFY ${config.nick} ${config.password}`);
      }
      for (const ch of config.channels) {
        send(`JOIN ${ch}`);
        logger.info({ channel: ch }, 'IRC joined channel');
      }
      connected = true;
      startPingTimer();
      return;
    }

    // Handle 433 (nick in use)
    if (command === '433') {
      logger.error('IRC nick in use — check NickServ registration');
      return;
    }

    if (command !== 'PRIVMSG') return;
    if (parts.length < 4) return;

    const target = parts[2];
    // Join all parts from index 3 onward to capture full message body
    // (JS split() without limit keeps everything; with limit it truncates)
    let message = parts.slice(3).join(' ');
    if (message.startsWith(':')) message = message.slice(1);

    const senderNick = prefix.includes('!') ? prefix.split('!')[0] : prefix;

    // Ignore own messages
    if (senderNick.toLowerCase() === config.nick.toLowerCase()) return;

    // Ignore NickServ messages
    if (senderNick === 'NickServ') return;

    handleMessage(senderNick, target, message);
  }

  function handleMessage(
    sender: string,
    target: string,
    message: string,
  ): void {
    const isChannel = target.startsWith('#');
    const isBot = BOT_NICKS.has(sender.toLowerCase());

    // Parse Matterbridge relays: [Nick] message
    let actualSender = sender;
    let actualMessage = message;
    let actualIsBot = isBot;
    if (sender.toLowerCase().startsWith('matterbridge')) {
      if (message.startsWith('[') && message.includes('] ')) {
        const bracketEnd = message.indexOf('] ');
        actualSender = message.slice(1, bracketEnd);
        actualMessage = message.slice(bracketEnd + 2);
        // Re-evaluate: the real sender may be a human relayed through Matterbridge
        actualIsBot = BOT_NICKS.has(actualSender.toLowerCase());
      }
    }

    // Update turn-taking
    if (actualIsBot) {
      recordBotMessage(isChannel ? target : sender);
    } else {
      resetTurnTaking(isChannel ? target : sender);
    }

    // Channel turn-taking check
    if (isChannel && !canRespond(target)) {
      logger.debug({ target, sender }, 'IRC turn-taking: suppressed');
      return;
    }

    // Build JID: irc:#channel or irc:sender (for DMs)
    const jid = isChannel ? `irc:${target}` : `irc:${sender}`;
    const timestamp = new Date().toISOString();

    // Report metadata
    opts.onChatMetadata(
      jid,
      timestamp,
      isChannel ? target : undefined,
      'irc',
      isChannel,
    );

    // Build NewMessage
    const newMsg: NewMessage = {
      id: `irc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: jid,
      sender: actualSender,
      sender_name: actualSender,
      content: actualMessage,
      timestamp,
      is_from_me: false,
      is_bot_message: actualIsBot,
    };

    opts.onMessage(jid, newMsg);
  }

  function startPingTimer(): void {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      send('PING :keepalive');
    }, 120_000); // Ping every 2 minutes
  }

  function stopPingTimer(): void {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (!shouldReconnect) return;
    if (reconnectTimer) return;
    logger.info('IRC reconnecting in 10s...');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      channel.connect().catch((err) => {
        logger.error({ err }, 'IRC reconnect failed');
        scheduleReconnect();
      });
    }, 10_000);
  }

  function doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        send(`NICK ${config.nick}`);
        send(`USER ${config.nick} 0 * :X Bot (NanoClaw IRC Adapter)`);
        // 001 handler above will finish setup
        // Resolve immediately — 001 comes async
        resolve();
      };

      const onError = (err: Error) => {
        logger.error({ err }, 'IRC connection error');
        connected = false;
        stopPingTimer();
        scheduleReconnect();
      };

      const onClose = () => {
        logger.warn('IRC connection closed');
        connected = false;
        stopPingTimer();
        scheduleReconnect();
      };

      const onData = (data: Buffer) => {
        buffer += data.toString('utf-8');
        const lines = buffer.split('\r\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line) parseLine(line);
        }
      };

      if (config.useTls) {
        socket = tls.connect(
          {
            host: config.host,
            port: config.port,
            rejectUnauthorized: false, // Self-signed cert on Ergo
          },
          onConnect,
        );
      } else {
        socket = new net.Socket();
        (socket as net.Socket).connect(config.port, config.host, onConnect);
      }

      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
      socket.once('error', reject); // Reject the connect promise on first error
    });
  }

  const channel: Channel = {
    name: 'irc',

    async connect(): Promise<void> {
      shouldReconnect = true;
      connected = false;
      buffer = '';
      lastResponseTime = {};
      depthCounter = {};
      await doConnect();
    },

    async sendMessage(jid: string, text: string): Promise<void> {
      if (!connected || !socket) {
        logger.warn({ jid }, 'IRC not connected, dropping outbound message');
        return;
      }

      // Extract IRC target from jid: "irc:#channel" -> "#channel"
      const target = jid.replace(/^irc:/, '');

      // Split long messages
      const chunks = splitMessage(text, IRC_MAX_LINE);
      for (const chunk of chunks) {
        send(`PRIVMSG ${target} :${chunk}`);
        // Small delay between chunks to avoid flood
        if (chunks.length > 1) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      recordResponse(target);
    },

    isConnected(): boolean {
      return connected;
    },

    ownsJid(jid: string): boolean {
      return jid.startsWith('irc:');
    },

    async disconnect(): Promise<void> {
      shouldReconnect = false;
      stopPingTimer();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket && !socket.destroyed) {
        send('QUIT :Adapter shutting down');
        socket.destroy();
      }
      socket = null;
      connected = false;
    },
  };

  return channel;
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) chunks.push(current);
      current = line.slice(0, maxLen);
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text.slice(0, maxLen)];
}

// Self-register
registerChannel('irc', (opts) => createIRCChannel(opts));
