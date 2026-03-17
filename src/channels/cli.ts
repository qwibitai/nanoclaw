/**
 * CLI Channel for NanoClaw
 * Readline-based channel that accepts messages from stdin and prints
 * agent responses to stdout. No external services or tokens needed.
 */
import readline from 'readline';
import { Channel, NewMessage, OnInboundMessage, OnChatMetadata } from '../types.js';
import { ASSISTANT_NAME } from '../config.js';
import { registerChannel, ChannelOpts } from './registry.js';

class CliChannel implements Channel {
  name = 'cli';
  private rl: readline.Interface | null = null;
  private connected = false;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: ChannelOpts['registeredGroups'];

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
  }

  private getCliJid(): string {
    const groups = this.registeredGroups();
    for (const [jid] of Object.entries(groups)) {
      if (jid.startsWith('cli:')) return jid;
    }
    return 'cli:main';
  }

  async connect(): Promise<void> {
    // Only start readline if stdin is a TTY (interactive terminal).
    // When running as a launchd/systemd service, stdin is /dev/null — skip.
    if (!process.stdin.isTTY) {
      this.connected = true;
      return;
    }

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'You: ',
    });

    this.rl.on('line', (line) => {
      const content = line.trim();
      if (!content) {
        this.rl?.prompt();
        return;
      }

      const jid = this.getCliJid();
      const timestamp = new Date().toISOString();
      const msg: NewMessage = {
        id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: jid,
        sender: 'cli:user',
        sender_name: 'User',
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      this.onChatMetadata(jid, timestamp, 'CLI', 'cli', false);
      this.onMessage(jid, msg);
    });

    this.rl.on('close', () => {
      this.connected = false;
    });

    this.connected = true;
    this.rl.prompt();
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    // Strip <internal>...</internal> tags
    const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
    if (!cleaned) return;

    const lines = cleaned.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const prefix = i === 0 ? `${ASSISTANT_NAME}: ` : '  ';
      process.stdout.write(`${prefix}${lines[i]}\n`);
    }

    if (this.rl) {
      this.rl.prompt();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('cli:');
  }

  async disconnect(): Promise<void> {
    this.rl?.close();
    this.rl = null;
    this.connected = false;
  }
}

registerChannel('cli', (opts: ChannelOpts) => new CliChannel(opts));
