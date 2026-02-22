/**
 * ntfy.sh channel — outbound-only push notifications.
 *
 * Sends agent responses and errors as push notifications via ntfy.sh's
 * HTTP API. Stateless — no connection management needed.
 * ownsJid() returns false so this channel never claims inbound messages.
 */

import { logger } from '../logger.js';
import type { Channel } from '../types.js';

export interface NtfyChannelOpts {
  serverUrl: string;
  topic: string;
  token?: string;
}

const MAX_BODY_LENGTH = 500;

export class NtfyChannel implements Channel {
  name = 'ntfy';
  private url: string;
  private token?: string;

  constructor(opts: NtfyChannelOpts) {
    const server = opts.serverUrl.replace(/\/$/, '');
    this.url = `${server}/${opts.topic}`;
    this.token = opts.token;
  }

  async connect(): Promise<void> {
    logger.info({ url: this.url }, 'ntfy channel ready');
  }

  async disconnect(): Promise<void> {}

  isConnected(): boolean {
    return true;
  }

  ownsJid(_jid: string): boolean {
    return false;
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    await this.post(text, { Title: 'Warren', Priority: '3', Tags: 'white_check_mark' });
  }

  async sendProgress(_jid: string, tool: string, summary: string): Promise<void> {
    await this.post(summary, { Title: `Warren — ${tool}`, Priority: '1', Tags: 'gear' });
  }

  async sendResult(_jid: string, summary: string): Promise<void> {
    if (!summary) return;
    await this.post(summary, { Title: 'Warren — Done', Priority: '3', Tags: 'white_check_mark' });
  }

  private async post(body: string, extra: Record<string, string>): Promise<void> {
    const truncated = body.length > MAX_BODY_LENGTH
      ? body.slice(0, MAX_BODY_LENGTH) + '...'
      : body;

    const headers: Record<string, string> = {
      'Content-Type': 'text/plain',
      ...extra,
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const resp = await fetch(this.url, { method: 'POST', headers, body: truncated });
      if (!resp.ok) {
        logger.warn({ status: resp.status }, 'ntfy send non-OK response');
      }
    } catch (err) {
      logger.warn({ err }, 'ntfy send failed (best-effort)');
    }
  }
}
