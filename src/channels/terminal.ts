import readline from 'readline';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage } from '../types.js';

export const TERMINAL_JID = 'term:main';

export interface TerminalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class TerminalChannel implements Channel {
  name = 'terminal';
  prefixAssistantName = true;

  private rl: readline.Interface | null = null;
  private _connected = false;
  private opts: TerminalChannelOpts;

  constructor(opts: TerminalChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (!process.stdin.isTTY) {
      logger.debug('stdin is not a TTY, terminal channel dormant');
      return;
    }

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this._connected = true;

    this.rl.on('line', (line) => {
      const content = line.trim();
      if (!content) return;

      const timestamp = new Date().toISOString();
      const msg: NewMessage = {
        id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        chat_jid: TERMINAL_JID,
        sender: 'user',
        sender_name: process.env.USER || 'User',
        content,
        timestamp,
      };

      this.opts.onChatMetadata(TERMINAL_JID, timestamp, 'Terminal');
      this.opts.onMessage(TERMINAL_JID, msg);
    });

    this.rl.on('close', () => {
      this._connected = false;
      logger.info('Terminal channel closed');
    });

    console.log(`Terminal active. Chat with ${ASSISTANT_NAME} here.`);
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    if (!this._connected) return;
    console.log(text);
  }

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('term:');
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.rl?.close();
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // No typing indicator for terminal
  }
}
