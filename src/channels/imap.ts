import fs from 'fs';
import os from 'os';
import path from 'path';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const POLL_INTERVAL_MS = 60_000;

interface AccountConfig {
  imap: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
  };
  from: string;
  archiveFolder?: string;
  pollFolders?: string[];
}

interface AccountsConfig {
  accounts: Record<string, AccountConfig>;
}

function loadConfigFrom(
  configPath: string,
): Record<string, AccountConfig> | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = JSON.parse(
      fs.readFileSync(configPath, 'utf-8'),
    ) as AccountsConfig;
    if (!raw.accounts || typeof raw.accounts !== 'object') {
      logger.warn(
        { configPath },
        'IMAP: config missing "accounts" key — skipping',
      );
      return null;
    }
    return raw.accounts;
  } catch (err) {
    logger.warn({ err, configPath }, 'IMAP: failed to load config');
    return null;
  }
}

// Discover global IMAP accounts from ~/.imap-mcp/config.json.
// Per-channel local accounts (~/.imap-mcp-{folder}/) are tool-only — not polled.
function discoverImapConfigs(): Array<{
  accountName: string;
  account: AccountConfig;
}> {
  const globalPath = path.join(os.homedir(), '.imap-mcp', 'config.json');
  const accounts = loadConfigFrom(globalPath);
  if (!accounts) return [];
  return Object.entries(accounts).map(([accountName, account]) => ({
    accountName,
    account,
  }));
}

export class ImapChannel implements Channel {
  name: string;

  private jid: string;
  private opts: ChannelOpts;
  private config: AccountConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeen: Map<string, number> = new Map(); // folder → last seen UID
  private connected = false;

  constructor(jid: string, config: AccountConfig, opts: ChannelOpts) {
    this.name = `imap:${jid}`;
    this.jid = jid;
    this.config = config;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.connected = true;
    logger.info({ host: this.config.imap.host }, 'IMAP channel connected');
    console.log(`\n  IMAP channel: ${this.config.imap.auth.user}`);
    console.log(`  Polling inbox every ${POLL_INTERVAL_MS / 1000}s\n`);

    // Initial poll
    await this.poll();

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => logger.error({ err }, 'IMAP poll error'));
    }, POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    const folders = this.config.pollFolders ?? ['INBOX'];

    for (const folder of folders) {
      await this.pollFolder(folder);
    }
  }

  private async pollFolder(folder: string): Promise<void> {
    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: this.config.imap.auth,
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);

      try {
        const lastUid = this.lastSeen.get(folder) ?? 0;

        const messages: Array<{
          uid: number;
          from: string;
          subject: string;
          body: string;
          date: string;
        }> = [];

        for await (const msg of client.fetch(
          { seen: false },
          { uid: true, envelope: true },
        )) {
          const uid = msg.uid ?? 0;
          if (uid <= lastUid) continue;

          const envelope = msg.envelope;
          const from = envelope?.from?.[0]
            ? `${envelope.from[0].name ?? ''} <${envelope.from[0].address ?? ''}>`.trim()
            : 'Unknown';
          const subject = envelope?.subject ?? '(no subject)';
          const date =
            envelope?.date?.toISOString() ?? new Date().toISOString();

          // Fetch the full message source for body text
          let body = '';
          try {
            const fullMsg = await client.fetchOne(
              String(uid),
              { source: true },
              { uid: true },
            );
            if (fullMsg && fullMsg.source) {
              const raw = Buffer.isBuffer(fullMsg.source)
                ? fullMsg.source.toString('utf-8')
                : String(fullMsg.source);
              const bodyStart = raw.indexOf('\r\n\r\n');
              body = bodyStart !== -1 ? raw.slice(bodyStart + 4) : raw;
            }
          } catch {
            body = '(body unavailable)';
          }

          messages.push({
            uid,
            from,
            subject,
            body: body.slice(0, 4000),
            date,
          });
        }

        if (messages.length === 0) {
          lock.release();
          return;
        }

        // Update lastSeen
        const maxUid = Math.max(...messages.map((m) => m.uid));
        this.lastSeen.set(folder, maxUid);

        // Deliver each email as a message
        for (const msg of messages) {
          const content = `[Email from ${msg.from}] ${msg.subject}\n\n${msg.body}`;
          const timestamp = msg.date;

          this.opts.onChatMetadata(
            this.jid,
            timestamp,
            'IMAP Inbox',
            'imap',
            false,
          );

          const group = this.opts.registeredGroups()[this.jid];
          if (!group) {
            logger.debug(
              { uid: msg.uid, subject: msg.subject },
              'IMAP: no registered group for imap:inbox',
            );
            lock.release();
            return;
          }

          this.opts.onMessage(this.jid, {
            id: `imap-${msg.uid}`,
            chat_jid: this.jid,
            sender: msg.from,
            sender_name: msg.from,
            content,
            timestamp,
            is_from_me: false,
          });

          logger.info(
            { uid: msg.uid, subject: msg.subject, from: msg.from },
            'IMAP message delivered',
          );
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      logger.error({ err, folder }, 'IMAP poll failed');
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore logout errors
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (jid !== this.jid) return;

    try {
      const transport = nodemailer.createTransport({
        host: this.config.smtp.host,
        port: this.config.smtp.port,
        secure: this.config.smtp.secure,
        auth: this.config.smtp.auth,
      });

      // Determine recipient from registered group config (fallback to smtp user)
      const groups = this.opts.registeredGroups();
      const group = groups[jid];
      const to = (group as any)?.imapReplyTo ?? this.config.smtp.auth.user;

      await transport.sendMail({
        from: this.config.from,
        to,
        subject: 'NanoClaw reply',
        text,
      });

      logger.info({ jid, to }, 'IMAP: sent reply via SMTP');
    } catch (err) {
      logger.error({ jid, err }, 'IMAP: failed to send message via SMTP');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid === this.jid;
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    logger.info('IMAP channel disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // IMAP does not support typing indicators
  }
}

// Register one channel instance per account in the global config.
for (const { accountName, account } of discoverImapConfigs()) {
  const jid = `imap:${accountName}`;
  registerChannel(
    jid,
    (opts: ChannelOpts) => new ImapChannel(jid, account, opts),
  );
}
