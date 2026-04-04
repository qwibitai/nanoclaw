// Copyright (c) 2026 Botler 360 SAS. All rights reserved.
// See LICENSE.md for license terms.

import fs from 'fs';
import path from 'path';
import os from 'os';

import { Firestore } from '@google-cloud/firestore';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

import { calculateBackoff } from '../backoff.js';
import { GOOGLE_CHAT_POLL_MS } from '../constants.js';
import { logger } from '../logger.js';
import { observeHistogram } from '../metrics.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface GoogleChatChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface FirestoreMessage {
  id: string;
  spaceId: string;
  spaceName: string;
  messageId: string;
  messageName: string;
  text: string;
  senderName: string;
  senderEmail: string;
  senderType: string;
  createTime: string;
  agentName: string;
  spaceType?: string;
  yacinePresent?: boolean;
  processed?: boolean;
}

const AGENT_NAME = process.env.GOOGLE_CHAT_AGENT_NAME || 'nanoclaw';

const SERVICE_ACCOUNT_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(os.homedir(), '.firebase-mcp', 'adp-service-account.json');

// Chat Bot SA for sending messages (has chat.bot scope)
const CHAT_BOT_SA_PATH =
  process.env.GOOGLE_CHAT_BOT_SA ||
  path.join(os.homedir(), '.firebase-mcp', 'chat-bot-sa.json');

export class GoogleChatChannel implements Channel {
  name = 'google-chat';

  private firestore: Firestore | null = null;
  private auth: GoogleAuth | null = null;
  private chatBotAuth: GoogleAuth | null = null;
  private opts: GoogleChatChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveErrors = 0;
  private lastDeliveredSpaceName = '';
  private spaceIdToName = new Map<string, string>();

  constructor(
    opts: GoogleChatChannelOpts,
    pollIntervalMs = GOOGLE_CHAT_POLL_MS,
  ) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
      logger.warn(
        { path: SERVICE_ACCOUNT_PATH },
        'Google Chat: service account not found. Skipping.',
      );
      return;
    }

    // Initialize Firestore with service account
    this.firestore = new Firestore({
      keyFilename: SERVICE_ACCOUNT_PATH,
    });

    // Initialize Google Auth for Chat API calls (use chat-bot SA for sending)
    const chatSaPath = fs.existsSync(CHAT_BOT_SA_PATH)
      ? CHAT_BOT_SA_PATH
      : SERVICE_ACCOUNT_PATH;
    this.chatBotAuth = new GoogleAuth({
      keyFile: chatSaPath,
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    });
    this.auth = this.chatBotAuth;

    logger.info('Google Chat channel connected (Firestore polling)');

    // Start polling with error backoff
    const schedulePoll = () => {
      const backoffMs = calculateBackoff(
        this.consecutiveErrors,
        this.pollIntervalMs,
        5 * 60 * 1000,
      );
      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) => logger.error({ err }, 'Google Chat poll error'))
          .finally(() => {
            if (this.firestore) schedulePoll();
          });
      }, backoffMs);
    };

    // Initial poll
    await this.pollForMessages();
    schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.auth) {
      logger.warn('Google Chat auth not initialized');
      return;
    }

    // jid format: gchat:spaces/XXX
    let spaceId = jid.replace(/^gchat:/, '');

    // If jid is 'main', use the last delivered space
    if (spaceId === 'main' && this.lastDeliveredSpaceName) {
      spaceId = this.lastDeliveredSpaceName;
    }

    if (!spaceId || !spaceId.startsWith('spaces/')) {
      logger.warn(
        { jid, spaceId },
        'Google Chat: invalid space ID, cannot send',
      );
      return;
    }

    const spaceName = spaceId;

    try {
      const client = await this.auth.getClient();
      const accessToken = await client.getAccessToken();

      const url = `https://chat.googleapis.com/v1/${spaceName}/messages`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const body = await response.text();
        logger.error(
          { spaceName, status: response.status, body },
          'Google Chat API error sending message',
        );
        return;
      }

      logger.info({ spaceName }, 'Google Chat message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Google Chat message');
    }
  }

  isConnected(): boolean {
    return this.firestore !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gchat:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.firestore) {
      await this.firestore.terminate();
    }
    this.firestore = null;
    this.auth = null;
    logger.info('Google Chat channel stopped');
  }

  // --- Private ---

  private async pollForMessages(): Promise<void> {
    if (!this.firestore) return;
    const start = Date.now();

    try {
      const collectionPath = `chat-queue/${AGENT_NAME}/messages`;
      const snapshot = await this.firestore
        .collection(collectionPath)
        .where('processed', '==', false)
        .limit(20)
        .get();

      if (snapshot.empty) {
        this.consecutiveErrors = 0;
        return;
      }

      // Sort by createTime client-side to avoid composite index requirement
      const docs = [...snapshot.docs].sort((a, b) => {
        const tA = a.data().createTime || '';
        const tB = b.data().createTime || '';
        return tA < tB ? -1 : tA > tB ? 1 : 0;
      });

      for (const doc of docs) {
        const data = doc.data() as FirestoreMessage;
        await this.processMessage(doc.id, data);
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const backoffMs = calculateBackoff(
        this.consecutiveErrors,
        this.pollIntervalMs,
        5 * 60 * 1000,
      );
      logger.error(
        {
          err,
          consecutiveErrors: this.consecutiveErrors,
          nextPollMs: backoffMs,
        },
        'Google Chat poll failed',
      );
    } finally {
      observeHistogram(
        'nanoclaw_gchat_poll_duration_seconds',
        (Date.now() - start) / 1000,
      );
    }
  }

  private async processMessage(
    docId: string,
    data: FirestoreMessage,
  ): Promise<void> {
    if (!this.firestore) return;

    // Only respond in spaces where yacine@ is present
    if (data.yacinePresent === false) {
      logger.debug(
        { spaceId: data.spaceId, docId },
        'Google Chat: skipping message — yacine not present in space',
      );
      await this.markProcessed(docId);
      return;
    }

    // Use the space ID as the chat jid so replies route back through Google Chat
    const chatJid = `gchat:${data.spaceId}`;
    const timestamp = data.createTime || new Date().toISOString();

    // Store chat metadata for group discovery
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      data.spaceName || data.spaceId,
      'google-chat',
      data.spaceType !== 'DIRECT_MESSAGE',
    );

    // Track space ID → space name for reply routing
    this.spaceIdToName.set(data.spaceId, data.spaceId);
    // Cap to prevent unbounded growth
    if (this.spaceIdToName.size > 500) {
      const entries = [...this.spaceIdToName.entries()];
      this.spaceIdToName = new Map(entries.slice(entries.length - 250));
    }
    this.lastDeliveredSpaceName = data.spaceId;

    // Deliver with chat_jid matching the main group so it gets stored correctly,
    // but prefix content so the agent knows it's from Google Chat.
    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);

    if (!mainEntry) {
      logger.debug(
        { chatJid },
        'No main group registered, skipping Google Chat message',
      );
      await this.markProcessed(docId);
      return;
    }

    const mainJid = mainEntry[0];
    const spaceName = data.spaceName || data.spaceId;
    const content = `[Google Chat from ${data.senderName} <${data.senderEmail}> in ${spaceName}]\n[Reply to: gchat:${data.spaceId}]\n\n${data.text}`;

    this.opts.onMessage(mainJid, {
      id: data.messageId || docId,
      chat_jid: mainJid,
      sender: data.senderEmail,
      sender_name: data.senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    // Mark as processed in Firestore
    await this.markProcessed(docId);

    logger.info(
      { mainJid, from: data.senderName, space: data.spaceName },
      'Google Chat message delivered to main group',
    );
  }

  private async markProcessed(docId: string): Promise<void> {
    if (!this.firestore) return;

    try {
      const collectionPath = `chat-queue/${AGENT_NAME}/messages`;
      await this.firestore.collection(collectionPath).doc(docId).update({
        processed: true,
        processedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn(
        { docId, err },
        'Failed to mark Google Chat message as processed',
      );
    }
  }
}

registerChannel('google-chat', (opts: ChannelOpts) => {
  if (process.env.GOOGLE_CHAT_ENABLED !== 'true') {
    return null;
  }
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    logger.warn(
      'Google Chat: service account not found at ' + SERVICE_ACCOUNT_PATH,
    );
    return null;
  }
  return new GoogleChatChannel(opts);
});
