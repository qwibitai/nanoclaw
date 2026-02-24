import fs from 'fs';
import path from 'path';

import WebSocket from 'ws';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface ExtractedContent {
  text: string | null;
  type: 'text' | 'image' | 'unknown';
  imageBase64?: string;
  caption?: string;
}

export interface SimplexChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** @internal - override WebSocket constructor for testing */
  createWebSocket?: (url: string) => WebSocket;
}

export class SimplexChannel implements Channel {
  name = 'simplex';

  private port: number;
  private ws: WebSocket | null = null;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private corrId = 0;
  private shouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Cache display names for sending commands (SimpleX CLI needs names, not IDs)
  private contactNames = new Map<number, string>();
  private groupNames = new Map<number, string>();

  // Pending file transfers: fileId → message context waiting for download
  private pendingFiles = new Map<number, {
    jid: string;
    msgId: string;
    extracted: ExtractedContent;
    folder: string;
    sender: string;
    senderName: string;
    timestamp: string;
  }>();

  private filesDir: string | null = null;
  private opts: SimplexChannelOpts;
  private createWs: (url: string) => WebSocket;

  constructor(port: number, opts: SimplexChannelOpts) {
    this.port = port;
    this.opts = opts;
    this.createWs = opts.createWebSocket ?? ((url) => new WebSocket(url));
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve, reject);
    });
  }

  private connectInternal(
    onFirstOpen?: () => void,
    onFirstError?: (err: Error) => void,
  ): void {
    const url = `ws://localhost:${this.port}`;
    logger.info({ url }, 'Connecting to SimpleX Chat CLI');

    this.ws = this.createWs(url);

    this.ws.on('open', () => {
      this.connected = true;
      logger.info('Connected to SimpleX Chat CLI');

      // Set file download dir to /tmp so XFTP rename() doesn't cross filesystems
      this.filesDir = fs.mkdtempSync('/tmp/nanoclaw-sx-');
      this.sendCommand(`/_files_folder ${this.filesDir}`);

      this.flushOutgoingQueue().catch((err) =>
        logger.error({ err }, 'Failed to flush outgoing queue'),
      );

      if (onFirstOpen) {
        onFirstOpen();
        onFirstOpen = undefined;
        onFirstError = undefined;
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const raw = data.toString();
        const parsed = JSON.parse(raw);
        this.handleEvent(parsed);
      } catch (err) {
        logger.debug({ err, data: String(data).slice(0, 200) }, 'Failed to parse SimpleX event');
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      logger.info({ queuedMessages: this.outgoingQueue.length }, 'SimpleX WebSocket closed');

      if (this.shouldReconnect) {
        this.scheduleReconnect(5000);
      }
    });

    this.ws.on('error', (err) => {
      logger.error({ err }, 'SimpleX WebSocket error');

      if (onFirstError) {
        onFirstError(err);
        onFirstError = undefined;
        onFirstOpen = undefined;
      }
    });
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    logger.info({ delayMs }, 'Scheduling SimpleX reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info('Attempting SimpleX reconnect...');
      this.connectInternal(
        undefined,
        () => {
          // Reconnect failed, try again with longer backoff
          this.scheduleReconnect(10000);
        },
      );
    }, delayMs);
  }

  private handleEvent(parsed: Record<string, unknown>): void {
    // SimpleX CLI sends responses as { corrId, resp } or { resp } for async events
    const resp = parsed.resp as Record<string, unknown> | undefined;
    if (!resp || typeof resp !== 'object') return;

    const type = resp.type as string | undefined;
    if (!type) return;

    if (type === 'newChatItems') {
      this.handleNewChatItems(resp);
    } else if (type === 'rcvFileComplete') {
      this.handleFileComplete(resp);
    }
  }

  private handleNewChatItems(resp: Record<string, unknown>): void {
    const chatItems = resp.chatItems as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(chatItems)) return;

    for (const item of chatItems) {
      try {
        this.processChatItem(item);
      } catch (err) {
        logger.debug({ err, item: JSON.stringify(item).slice(0, 300) }, 'Failed to process chat item');
      }
    }
  }

  private handleFileComplete(resp: Record<string, unknown>): void {
    // rcvFileComplete has { chatItem: { chatInfo, chatItem: { file: { fileId, filePath } } } }
    const outerChatItem = (resp.chatItem ?? resp.chatItem_) as Record<string, unknown> | undefined;
    const innerChatItem = outerChatItem?.chatItem as Record<string, unknown> | undefined;
    const fileInfo = innerChatItem?.file as Record<string, unknown> | undefined;
    if (!fileInfo) return;

    const fileId = fileInfo.fileId as number;
    // filePath is relative, under fileSource.filePath
    const fileSource = fileInfo.fileSource as Record<string, unknown> | undefined;
    const relPath = (fileSource?.filePath ?? fileInfo.filePath) as string | undefined;
    const filePath = relPath && this.filesDir ? path.join(this.filesDir, relPath) : undefined;
    const pending = this.pendingFiles.get(fileId);
    if (!pending) return;
    this.pendingFiles.delete(fileId);

    logger.info({ fileId, filePath }, 'SimpleX file transfer complete');

    if (!filePath) {
      // No file path — deliver with thumbnail fallback
      const messageText = this.composeMessageText(pending.extracted, pending.folder, pending.msgId);
      if (!messageText) return;
      this.deliverMessage(pending, messageText);
      return;
    }

    // Copy the full-res file to the group's media dir
    try {
      const ext = path.extname(filePath).slice(1) || 'jpg';
      const filename = `${pending.msgId}.${ext}`;
      const mediaDir = path.join(GROUPS_DIR, pending.folder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const destPath = path.join(mediaDir, filename);
      fs.copyFileSync(filePath, destPath);
      const stats = fs.statSync(destPath);
      logger.info({ destPath, size: stats.size }, 'Saved full-res SimpleX image');

      let imageRef = `[Image: /workspace/group/media/${filename}]`;
      const messageText = pending.extracted.caption
        ? `${imageRef}\n${pending.extracted.caption}`
        : imageRef;
      this.deliverMessage(pending, messageText);
    } catch (err) {
      logger.error({ err, fileId }, 'Failed to copy received file');
      // Fall back to thumbnail
      const messageText = this.composeMessageText(pending.extracted, pending.folder, pending.msgId);
      if (messageText) this.deliverMessage(pending, messageText);
    }
  }

  private deliverMessage(
    pending: { jid: string; msgId: string; sender: string; senderName: string; timestamp: string },
    content: string,
  ): void {
    this.opts.onMessage(pending.jid, {
      id: pending.msgId,
      chat_jid: pending.jid,
      sender: pending.sender,
      sender_name: pending.senderName,
      content,
      timestamp: pending.timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private processChatItem(item: Record<string, unknown>): void {
    const chatInfo = item.chatInfo as Record<string, unknown> | undefined;
    const chatItem = item.chatItem as Record<string, unknown> | undefined;
    if (!chatInfo || !chatItem) return;

    // Only handle received messages (not sent ones)
    const chatDir = chatItem.chatDir as Record<string, unknown> | undefined;
    if (!chatDir) return;
    const dirType = chatDir.type as string | undefined;
    if (dirType !== 'directRcv' && dirType !== 'groupRcv') return;

    // Extract content (text, image, etc.)
    const content = chatItem.content as Record<string, unknown> | undefined;
    if (!content) return;
    const extracted = this.extractContent(content);
    if (extracted.type === 'unknown' && !extracted.text) return;

    const chatInfoType = chatInfo.type as string | undefined;
    const timestamp = new Date().toISOString();
    const msgId = `sx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Log file field to understand full-resolution image delivery
    const fileInfo = chatItem.file as Record<string, unknown> | undefined;
    if (fileInfo) {
      logger.debug({ file: fileInfo }, 'SimpleX chatItem.file field');
    }

    if (chatInfoType === 'direct') {
      const contact = chatInfo.contact as Record<string, unknown> | undefined;
      if (!contact) return;

      const contactId = contact.contactId as number;
      const localName = (contact.localDisplayName as string) || undefined;
      const profile = contact.profile as Record<string, unknown> | undefined;
      const displayName = (profile?.displayName as string) || localName || `contact-${contactId}`;

      // Cache the localDisplayName for sending (SimpleX CLI routes by this, not profile.displayName)
      this.contactNames.set(contactId, localName || displayName);

      const jid = `sx:${contactId}`;

      this.opts.onChatMetadata(jid, timestamp, displayName, 'simplex', false);

      const groups = this.opts.registeredGroups();
      if (groups[jid]) {
        this.deliverOrDefer(extracted, groups[jid].folder, msgId, fileInfo, {
          jid, msgId, sender: `sx:user:${contactId}`, senderName: displayName, timestamp,
        });
      }
    } else if (chatInfoType === 'group') {
      const groupInfo = chatInfo.groupInfo as Record<string, unknown> | undefined;
      if (!groupInfo) return;

      const groupId = groupInfo.groupId as number;
      const localGroupName = (groupInfo.localDisplayName as string) || undefined;
      const groupProfile = groupInfo.groupProfile as Record<string, unknown> | undefined;
      const groupName = (groupProfile?.displayName as string) || localGroupName || `group-${groupId}`;

      // Cache the localDisplayName for sending (SimpleX CLI routes by this)
      this.groupNames.set(groupId, localGroupName || groupName);

      // Extract sender info from chatDir for group messages
      const groupMember = chatDir.groupMember as Record<string, unknown> | undefined;
      const memberProfile = groupMember?.memberProfile as Record<string, unknown> | undefined;
      const senderName = (memberProfile?.displayName as string) || 'unknown';
      const memberId = groupMember?.memberId as number | undefined;

      const jid = `sx:g:${groupId}`;

      this.opts.onChatMetadata(jid, timestamp, groupName, 'simplex', true);

      const groups = this.opts.registeredGroups();
      if (groups[jid]) {
        this.deliverOrDefer(extracted, groups[jid].folder, msgId, fileInfo, {
          jid, msgId, sender: `sx:member:${memberId ?? 0}`, senderName, timestamp,
        });
      }
    }
  }

  private deliverOrDefer(
    extracted: ExtractedContent,
    folder: string,
    msgId: string,
    fileInfo: Record<string, unknown> | undefined,
    ctx: { jid: string; msgId: string; sender: string; senderName: string; timestamp: string },
  ): void {
    // If there's a file transfer to accept (full-res image), defer delivery
    const fileStatus = fileInfo?.fileStatus as Record<string, unknown> | undefined;
    const fileId = fileInfo?.fileId as number | undefined;
    if (extracted.type === 'image' && fileId && fileStatus?.type === 'rcvInvitation') {
      this.pendingFiles.set(fileId, { ...ctx, extracted, folder });
      this.sendCommand(`/freceive ${fileId}`);
      logger.info({ fileId, msgId }, 'Accepted file transfer, deferring message delivery');
      return;
    }

    // Deliver immediately (text messages, or images without file transfer)
    const messageText = this.composeMessageText(extracted, folder, msgId);
    if (!messageText) return;
    this.deliverMessage(ctx, messageText);
  }

  private composeMessageText(extracted: ExtractedContent, groupFolder: string, msgId: string): string | null {
    if (extracted.type === 'text') {
      return extracted.text;
    }

    if (extracted.type === 'image') {
      let imageRef = '[Image]';
      if (extracted.imageBase64) {
        const filename = this.saveImage(groupFolder, msgId, extracted.imageBase64);
        if (filename) {
          imageRef = `[Image: /workspace/group/media/${filename}]`;
        }
      }
      return extracted.caption ? `${imageRef}\n${extracted.caption}` : imageRef;
    }

    return extracted.text;
  }

  private extractContent(content: Record<string, unknown>): ExtractedContent {
    // content.type can be "rcvMsgContent" or "sndMsgContent"
    const msgContent = content.msgContent as Record<string, unknown> | undefined;
    if (!msgContent) return { text: null, type: 'unknown' };

    const mcType = msgContent.type as string | undefined;
    if (mcType === 'text') {
      return { text: (msgContent.text as string) || null, type: 'text' };
    }

    if (mcType === 'image') {
      const imageBase64 = (msgContent.image as string) || undefined;
      const caption = (msgContent.text as string) || undefined;
      return { text: caption || null, type: 'image', imageBase64, caption };
    }

    // For other content types that may have text (link previews, etc.)
    if (typeof msgContent.text === 'string' && msgContent.text) {
      return { text: msgContent.text, type: 'text' };
    }

    logger.debug({ mcType }, 'Unknown SimpleX message content type');
    return { text: null, type: 'unknown' };
  }

  private saveImage(groupFolder: string, msgId: string, base64Data: string): string | null {
    try {
      // Strip data URI prefix if present (e.g. "data:image/jpg;base64,...")
      const commaIdx = base64Data.indexOf(',');
      const raw = commaIdx >= 0 ? base64Data.slice(commaIdx + 1) : base64Data;
      const buf = Buffer.from(raw, 'base64');
      // Detect format from data URI or magic bytes
      const isPng = base64Data.startsWith('data:image/png') || (buf[0] === 0x89 && buf[1] === 0x50);
      const ext = isPng ? 'png' : 'jpg';
      const filename = `${msgId}.${ext}`;
      const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const filePath = path.join(mediaDir, filename);
      fs.writeFileSync(filePath, buf);
      logger.info({ filePath, size: buf.length }, 'Saved SimpleX image');
      return filename;
    } catch (err) {
      logger.error({ err, msgId }, 'Failed to save SimpleX image');
      return null;
    }
  }

  private sendCommand(cmd: string): void {
    // WebSocket.OPEN === 1
    if (!this.ws || this.ws.readyState !== 1) {
      logger.warn({ cmd: cmd.slice(0, 100) }, 'Cannot send SimpleX command, WebSocket not open');
      return;
    }

    const payload = JSON.stringify({
      corrId: `${++this.corrId}`,
      cmd,
    });

    this.ws.send(payload);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info({ jid, length: text.length, queueSize: this.outgoingQueue.length }, 'SimpleX disconnected, message queued');
      return;
    }

    try {
      const cmd = this.buildSendCommand(jid, text);
      if (!cmd) {
        logger.warn({ jid }, 'Cannot build SimpleX send command for JID');
        return;
      }
      this.sendCommand(cmd);
      logger.info({ jid, length: text.length }, 'SimpleX message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send SimpleX message, queued');
    }
  }

  private buildSendCommand(jid: string, text: string): string | null {
    if (jid.startsWith('sx:g:')) {
      const groupId = parseInt(jid.slice(5), 10);
      const groupName = this.groupNames.get(groupId);
      if (groupName) {
        return `#${groupName} ${text}`;
      }
      // Fallback: use /send command with numeric ID
      return `/send #${groupId} text ${text}`;
    }

    if (jid.startsWith('sx:')) {
      const contactId = parseInt(jid.slice(3), 10);
      const contactName = this.contactNames.get(contactId);
      if (contactName) {
        return `@${contactName} ${text}`;
      }
      // Fallback: use /send command with numeric ID
      return `/send @${contactId} text ${text}`;
    }

    return null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sx:');
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.filesDir) {
      fs.rmSync(this.filesDir, { recursive: true, force: true });
      this.filesDir = null;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing SimpleX outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const cmd = this.buildSendCommand(item.jid, item.text);
        if (cmd) {
          this.sendCommand(cmd);
          logger.info({ jid: item.jid, length: item.text.length }, 'Queued SimpleX message sent');
        } else {
          logger.warn({ jid: item.jid }, 'Dropped queued message, cannot build send command');
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
