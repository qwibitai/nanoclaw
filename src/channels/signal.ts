import fs from 'fs';
import path from 'path';

import { SignalCli } from 'signal-sdk';

import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudioFile } from '../transcription.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const SIGNAL_PREFIX = 'signal:';

/**
 * Strips the `signal:` prefix from a JID to get the raw phone number.
 * If the prefix is absent, returns the string unchanged (safety fallback).
 */
function jidToPhone(jid: string): string {
  return jid.startsWith(SIGNAL_PREFIX) ? jid.slice(SIGNAL_PREFIX.length) : jid;
}

/**
 * Converts a raw phone number to the nanoclaw JID format used for Signal.
 */
function phoneToJid(phone: string): string {
  return `${SIGNAL_PREFIX}${phone}`;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private signal!: InstanceType<typeof SignalCli>;
  private phoneNumber: string;
  private connected = false;
  private outgoingQueue: Array<{ phone: string; text: string }> = [];
  private flushing = false;
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    this.phoneNumber = process.env.SIGNAL_PHONE_NUMBER ?? '';
  }

  async connect(): Promise<void> {
    const dataDir = path.join(STORE_DIR, 'signal');
    fs.mkdirSync(dataDir, { recursive: true });
    this.signal = new SignalCli(dataDir, this.phoneNumber);

    this.signal.on('message', (params: unknown) => {
      this.handleMessage(params).catch((err) =>
        logger.error({ err }, 'Signal: unhandled error in message handler'),
      );
    });

    await this.signal.connect();
    this.connected = true;
    logger.info({ phoneNumber: this.phoneNumber }, 'Signal: connected');

    // Flush any messages queued while disconnected
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Signal: failed to flush outgoing queue'),
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(SIGNAL_PREFIX);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const phone = jidToPhone(jid);
    const prefixed = `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ phone, text: prefixed });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Signal: disconnected, message queued',
      );
      return;
    }

    try {
      await this.signal.sendMessage(phone, prefixed);
      logger.info({ jid, length: prefixed.length }, 'Signal: message sent');
    } catch (err) {
      this.outgoingQueue.push({ phone, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Signal: send failed, message queued',
      );
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.signal.gracefulShutdown();
    logger.info('Signal: disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const phone = jidToPhone(jid);
      // sendTyping(recipient, stop?) — stop is the inverse of isTyping
      await this.signal.sendTyping(phone, !isTyping);
    } catch (err) {
      logger.debug({ jid, err }, 'Signal: failed to send typing indicator');
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async handleMessage(params: unknown): Promise<void> {
    const p = params as Record<string, unknown>;
    const envelope = p?.envelope as Record<string, unknown> | undefined;
    if (!envelope) return;

    const source = (envelope.source ?? envelope.sourceNumber ?? '') as string;
    const sourceName = (envelope.sourceName ?? source) as string;
    const timestamp = new Date(
      Number(envelope.timestamp) || Date.now(),
    ).toISOString();

    const dataMsg = envelope.dataMessage as Record<string, unknown> | undefined;
    const syncMsg = envelope.syncMessage as Record<string, unknown> | undefined;

    // Only process data messages and sync messages (Note to Self outbound)
    if (!dataMsg && !syncMsg) return;

    let chatPhone: string;
    let text: string | undefined;
    let attachments: unknown[] = [];
    let isFromMe = false;
    let isBotMessage = false;

    if (syncMsg) {
      // syncMessage.sentMessage = message the bot sent (outbound sync from another device)
      const sent = syncMsg.sentMessage as Record<string, unknown> | undefined;
      if (!sent) return;

      chatPhone = (sent.destinationNumber ??
        sent.destination ??
        source) as string;
      text = sent.message as string | undefined;
      attachments = (sent.attachments as unknown[]) ?? [];
      isFromMe = true;
      isBotMessage = true;
    } else if (dataMsg) {
      chatPhone = source;
      text = dataMsg.message as string | undefined;
      attachments = (dataMsg.attachments as unknown[]) ?? [];
      isFromMe = false;
      // Detect bot messages by assistant name prefix (fallback detection)
      isBotMessage =
        typeof text === 'string' && text.startsWith(`${ASSISTANT_NAME}:`);
    } else {
      return;
    }

    // Find first audio attachment
    const audioAttachment = attachments.find((att) => {
      const a = att as Record<string, unknown>;
      return (
        typeof a.contentType === 'string' && a.contentType.startsWith('audio/')
      );
    }) as Record<string, unknown> | undefined;

    // Skip protocol-only messages — no text and no audio attachment
    if (!text && !audioAttachment) return;

    const chatJid = phoneToJid(chatPhone);

    // Always emit metadata for chat discovery
    this.opts.onChatMetadata(chatJid, timestamp, sourceName, 'signal', false);

    // Only deliver full message to registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[chatJid]) return;

    let finalContent = text ?? '';

    // Handle voice/audio transcription
    if (audioAttachment) {
      const localPath = audioAttachment.localPath as string | undefined;
      if (!localPath) {
        finalContent = '[Voice Message - transcription unavailable]';
      } else {
        try {
          const transcript = await transcribeAudioFile(localPath);
          if (transcript) {
            finalContent = `[Voice: ${transcript}]`;
            logger.info(
              { chatJid, length: transcript.length },
              'Signal: voice transcribed',
            );
          } else {
            finalContent = '[Voice Message - transcription unavailable]';
          }
        } catch (err) {
          logger.error({ err }, 'Signal: voice transcription error');
          finalContent = '[Voice Message - transcription failed]';
        }
      }
    }

    const id = `signal-${chatPhone}-${envelope.timestamp ?? Date.now()}`;
    const message: NewMessage = {
      id,
      chat_jid: chatJid,
      sender: phoneToJid(source),
      sender_name: sourceName,
      content: finalContent,
      timestamp,
      is_from_me: isFromMe,
      is_bot_message: isBotMessage,
    };

    this.opts.onMessage(chatJid, message);
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Signal: flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.signal.sendMessage(item.phone, item.text);
        logger.info({ phone: item.phone }, 'Signal: queued message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory registration — runs at module load time
// ---------------------------------------------------------------------------

registerChannel('signal', (opts: ChannelOpts) => {
  const configDir = path.join(STORE_DIR, 'signal');
  if (!fs.existsSync(configDir) || !process.env.SIGNAL_PHONE_NUMBER) {
    logger.warn('Signal: not configured. Run /add-signal to set up.');
    return null;
  }
  return new SignalChannel(opts);
});
