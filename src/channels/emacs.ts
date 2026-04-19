import fs from 'fs';
import http from 'http';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { setRegisteredGroup } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const EMACS_JID = 'emacs:default';

interface BufferedMessage {
  text: string;
  timestamp: number;
}

export class EmacsBridgeChannel implements Channel {
  name = 'emacs';

  private server: http.Server | null = null;
  private port: number;
  private authToken: string | null;
  private opts: ChannelOpts;
  private buffer: BufferedMessage[] = [];

  constructor(port: number, authToken: string | null, opts: ChannelOpts) {
    this.port = port;
    this.authToken = authToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.ensureGroupRegistered();
    this.ensureSymlink();
    this.ensureClaudeMd();

    this.server = http.createServer((req, res) => {
      if (!this.checkAuth(req, res)) return;

      const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);

      if (req.method === 'POST' && url.pathname === '/api/message') {
        this.handlePost(req, res);
      } else if (req.method === 'GET' && url.pathname === '/api/messages') {
        this.handlePoll(url, res);
      } else {
        res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        logger.info(
          { port: this.port },
          'Emacs channel listening — load emacs/nanoclaw.el to connect',
        );
        resolve();
      });
      this.server!.once('error', reject);
    });
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      logger.info('Emacs channel stopped');
    }
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    this.buffer.push({ text, timestamp: Date.now() });
    // Keep buffer bounded — 200 messages max
    if (this.buffer.length > 200) this.buffer.shift();
  }

  isConnected(): boolean {
    return this.server?.listening ?? false;
  }

  ownsJid(jid: string): boolean {
    return jid === EMACS_JID;
  }

  // --- Private helpers ---

  private checkAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): boolean {
    if (!this.authToken) return true;
    const header = req.headers['authorization'] ?? '';
    if (header === `Bearer ${this.authToken}`) return true;
    res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  private handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body) as { text?: string };
        if (!text?.trim()) {
          res.writeHead(400).end(JSON.stringify({ error: 'text required' }));
          return;
        }

        const timestamp = new Date().toISOString();
        const msgId = `emacs-${Date.now()}`;

        this.opts.onChatMetadata(EMACS_JID, timestamp, 'Emacs', 'emacs', false);
        this.opts.onMessage(EMACS_JID, {
          id: msgId,
          chat_jid: EMACS_JID,
          sender: 'emacs',
          sender_name: 'Emacs',
          content: text,
          timestamp,
          is_from_me: false,
        });

        res
          .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ messageId: msgId, timestamp: Date.now() }));

        logger.info({ length: text.length }, 'Emacs message received');
      } catch (err) {
        logger.error({ err }, 'Emacs channel: failed to parse POST body');
        res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handlePoll(url: URL, res: http.ServerResponse): void {
    const since = parseInt(url.searchParams.get('since') ?? '0', 10);
    const messages = this.buffer.filter((m) => m.timestamp > since);
    res
      .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ messages }));
  }

  private ensureClaudeMd(): void {
    const claudeMd = path.join(GROUPS_DIR, 'emacs', 'CLAUDE.md');
    // groups/emacs symlinks to the main group folder on typical installs, so
    // this is a no-op when that CLAUDE.md already exists. On a fresh setup it
    // bootstraps the file so the agent knows to output markdown, not org-mode.
    if (fs.existsSync(claudeMd)) return;
    const content = [
      '## Message Formatting',
      '',
      'This is an Emacs channel. Responses are automatically converted from markdown',
      'to org-mode by the bridge before display.',
      '',
      '**Always format responses in standard markdown:**',
      '- `**bold**` not `*bold*`',
      '- `*italic*` not `/italic/`',
      '- `~~strikethrough~~` not `+strikethrough+`',
      '- `` `code` `` not `~code~`',
      '- ` ```lang ` fenced code blocks',
      '- `- ` for bullet points',
      '',
      'Do NOT output org-mode syntax directly. The bridge handles conversion.',
      '',
    ].join('\n');
    try {
      fs.writeFileSync(claudeMd, content, 'utf8');
      logger.info('Emacs channel: wrote CLAUDE.md');
    } catch (err) {
      logger.warn({ err }, 'Emacs channel: could not write CLAUDE.md');
    }
  }

  private ensureGroupRegistered(): void {
    const groups = this.opts.registeredGroups();
    if (groups[EMACS_JID]) return;

    const newGroup: RegisteredGroup = {
      name: 'emacs',
      folder: 'emacs',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };

    try {
      setRegisteredGroup(EMACS_JID, newGroup);
      // Mutate the live cache so the message loop sees it immediately
      groups[EMACS_JID] = newGroup;
      logger.info('Emacs group auto-registered');
    } catch (err) {
      logger.error({ err }, 'Emacs channel: failed to auto-register group');
    }
  }

  private ensureSymlink(): void {
    const emacsDir = path.join(GROUPS_DIR, 'emacs');

    // Find the main group's folder name
    const groups = this.opts.registeredGroups();
    const mainGroup = Object.values(groups).find((g) => g.isMain);
    const targetFolder = mainGroup?.folder ?? 'main';
    const targetDir = path.join(GROUPS_DIR, targetFolder);

    try {
      const stat = fs.lstatSync(emacsDir);
      if (stat.isSymbolicLink()) return; // already set up
      // Exists as a real directory — leave it alone
      logger.debug(
        { emacsDir },
        'Emacs groups dir already exists as a directory',
      );
      return;
    } catch {
      // Does not exist — create it
    }

    // Ensure the target exists before symlinking
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    try {
      fs.symlinkSync(targetDir, emacsDir);
      logger.info({ target: targetDir }, 'Created groups/emacs symlink');
    } catch (err) {
      logger.error(
        { err },
        'Emacs channel: failed to create groups/emacs symlink',
      );
    }
  }
}

registerChannel('emacs', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['EMACS_CHANNEL_PORT', 'EMACS_AUTH_TOKEN']);
  const portStr =
    process.env.EMACS_CHANNEL_PORT || envVars.EMACS_CHANNEL_PORT || '8766';
  const port = parseInt(portStr, 10);
  const authToken =
    process.env.EMACS_AUTH_TOKEN || envVars.EMACS_AUTH_TOKEN || null;

  return new EmacsBridgeChannel(port, authToken, opts);
});
