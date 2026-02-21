/**
 * Warren channel — sends NanoClaw responses to Warren via HTTP callback.
 *
 * Warren writes IPC files to NanoClaw's message directory. NanoClaw
 * processes them and routes responses through this channel, which POSTs
 * them to Warren's internal callback endpoint.
 */

import { logger } from '../logger.js';
import type { Channel } from '../types.js';

export interface WarrenChannelOpts {
  callbackUrl: string;
}

export class WarrenChannel implements Channel {
  name = 'warren';
  private callbackUrl: string;

  constructor(opts: WarrenChannelOpts) {
    this.callbackUrl = opts.callbackUrl;
  }

  async connect(): Promise<void> {
    // Stateless HTTP — nothing to connect
    logger.info({ callbackUrl: this.callbackUrl }, 'Warren channel ready');
  }

  async disconnect(): Promise<void> {
    // Stateless HTTP — nothing to disconnect
  }

  isConnected(): boolean {
    return true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('warren:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const sessionId = jid.replace('warren:', '');
    const resp = await fetch(this.callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, text, type: 'text' }),
    });
    if (!resp.ok) {
      throw new Error(`Warren callback failed: ${resp.status}`);
    }
  }

  async sendProgress(jid: string, tool: string, summary: string): Promise<void> {
    const sessionId = jid.replace('warren:', '');
    const resp = await fetch(this.callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, type: 'tool', tool, summary }),
    });
    if (!resp.ok) {
      throw new Error(`Warren callback failed: ${resp.status}`);
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const sessionId = jid.replace('warren:', '');
    const url = this.callbackUrl.replace('/callback', '/typing');
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, is_typing: isTyping }),
    }).catch(() => {
      // Typing indicators are best-effort
    });
  }
}
