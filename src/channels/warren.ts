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
  internalSecret?: string;
}

export class WarrenChannel implements Channel {
  name = 'warren';
  private callbackUrl: string;
  private internalSecret: string;

  constructor(opts: WarrenChannelOpts) {
    this.callbackUrl = opts.callbackUrl;
    this.internalSecret = opts.internalSecret ?? '';
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.internalSecret) {
      headers['x-internal-secret'] = this.internalSecret;
    }
    return headers;
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
      headers: this.authHeaders(),
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
      headers: this.authHeaders(),
      body: JSON.stringify({ session_id: sessionId, type: 'tool', tool, summary }),
    });
    if (!resp.ok) {
      throw new Error(`Warren callback failed: ${resp.status}`);
    }
  }

  async sendResult(jid: string, summary: string): Promise<void> {
    const sessionId = jid.replace('warren:', '');
    await fetch(this.callbackUrl, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ session_id: sessionId, type: 'result', text: summary }),
    }).catch(() => {
      // Result notification is best-effort
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const sessionId = jid.replace('warren:', '');
    const url = this.callbackUrl.replace('/callback', '/typing');
    await fetch(url, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ session_id: sessionId, is_typing: isTyping }),
    }).catch(() => {
      // Typing indicators are best-effort
    });
  }

  async fetchConfig(): Promise<Record<string, unknown>> {
    const baseUrl = this.callbackUrl.replace('/internal/nanoclaw/callback', '');
    const resp = await fetch(`${baseUrl}/internal/nanoclaw/config`, {
      headers: this.authHeaders(),
    });
    if (!resp.ok) throw new Error(`Config fetch failed: ${resp.status}`);
    return resp.json() as Promise<Record<string, unknown>>;
  }

  async updateConfig(updates: Record<string, unknown>): Promise<Record<string, unknown>> {
    const baseUrl = this.callbackUrl.replace('/internal/nanoclaw/callback', '');
    const resp = await fetch(`${baseUrl}/internal/nanoclaw/config`, {
      method: 'PUT',
      headers: this.authHeaders(),
      body: JSON.stringify(updates),
    });
    if (!resp.ok) throw new Error(`Config update failed: ${resp.status}`);
    return resp.json() as Promise<Record<string, unknown>>;
  }
}
