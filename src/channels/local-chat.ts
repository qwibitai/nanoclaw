import { ASSISTANT_NAME } from '../config.js';
import {
  setOnNewMessage,
  clearOnNewMessage,
  broadcast,
  setAgentPresence,
} from '../chat-server.js';
import { storeChatMessage, getChatRoom } from '../chat-db.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

export class LocalChatChannel implements Channel {
  name = 'local-chat';

  private connected = false;
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    setOnNewMessage((roomId, message) => {
      const chatJid = `chat:${roomId}`;
      const timestamp = new Date(message.created_at).toISOString();

      const room = getChatRoom(roomId);
      const roomName = room?.name ?? roomId;

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        roomName,
        'local-chat',
        true,
      );

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, roomName },
          'Message from unregistered chat room',
        );
        return;
      }

      // For file messages, include the file path so the agent can access it
      let content = message.content;
      if (message.message_type === 'file' && message.file_meta) {
        const meta =
          typeof message.file_meta === 'string'
            ? JSON.parse(message.file_meta)
            : message.file_meta;
        const filePath = `/workspace/group/uploads/${meta.url.split('/').pop()}`;
        content = `[File: ${meta.filename} (${meta.mime}, ${meta.size} bytes) at ${filePath}]`;
        if (message.content && message.content !== meta.filename) {
          content += `\n${message.content}`;
        }
      }

      this.opts.onMessage(chatJid, {
        id: message.id,
        chat_jid: chatJid,
        sender: message.sender,
        sender_name: message.sender,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, roomName, sender: message.sender },
        'Local chat message stored',
      );
    });

    this.connected = true;
    logger.info('Local chat channel connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const roomId = jid.replace(/^chat:/, '');
    const stored = storeChatMessage(roomId, ASSISTANT_NAME, 'agent', text);
    broadcast(roomId, { type: 'message', ...stored });
    logger.info({ jid, length: text.length }, 'Local chat message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('chat:');
  }

  async disconnect(): Promise<void> {
    clearOnNewMessage();
    this.connected = false;
    logger.info('Local chat channel disconnected');
  }

  sendStatus(jid: string, event: string, detail?: string): void {
    const roomId = jid.replace(/^chat:/, '');
    broadcast(roomId, {
      type: 'status',
      room_id: roomId,
      event,
      detail,
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const roomId = jid.replace(/^chat:/, '');
    setAgentPresence(roomId, ASSISTANT_NAME, isTyping);
    broadcast(roomId, {
      type: 'typing',
      room_id: roomId,
      identity: ASSISTANT_NAME,
      identity_type: 'agent',
      is_typing: isTyping,
    });
  }
}

registerChannel('local-chat', (opts: ChannelOpts) => {
  if (process.env.CHAT_SERVER_ENABLED !== 'true') return null;
  return new LocalChatChannel(opts);
});
