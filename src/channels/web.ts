import { isWebJid, parseThreadJid } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

type WebBroadcastFn = (
  groupFolder: string,
  threadId: string | undefined,
  text: string,
) => void;

export class WebChannel implements Channel {
  name = 'web';

  private broadcastFn: WebBroadcastFn | null = null;

  constructor(_opts: ChannelOpts) {}

  /** Late-bind the broadcast function (set after WebSocket server starts). */
  setBroadcast(fn: WebBroadcastFn): void {
    this.broadcastFn = fn;
  }

  async connect(): Promise<void> {}

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.broadcastFn) {
      logger.warn({ jid }, 'Web channel: broadcast not set, dropping message');
      return;
    }

    const parsed = parseThreadJid(jid);
    if (parsed) {
      this.broadcastFn(parsed.parentId, parsed.threadId, text);
    } else {
      // Non-thread JID: web:{groupFolder}
      const groupFolder = jid.replace(/^web:/, '');
      this.broadcastFn(groupFolder, undefined, text);
    }
  }

  isConnected(): boolean {
    return this.broadcastFn !== null;
  }

  ownsJid(jid: string): boolean {
    return isWebJid(jid);
  }

  async disconnect(): Promise<void> {}
}

registerChannel('web', (opts: ChannelOpts) => new WebChannel(opts));
