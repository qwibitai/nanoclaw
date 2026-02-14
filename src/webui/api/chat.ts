import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { ServerDeps } from '../server.js';
import { getMessagesForGroup, storeChatMessage } from '../../db.js';

const WEB_CHAT_JID = 'web@chat';

export function registerChatRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/chat/history', async (req) => {
    const query = req.query as { limit?: string; before?: string };
    const limit = Math.min(parseInt(query.limit || '50', 10) || 50, 200);
    const messages = getMessagesForGroup(WEB_CHAT_JID, limit + 1, query.before);
    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();
    messages.reverse();
    return { messages, hasMore };
  });
}

export function handleChatWebSocket(ws: WebSocket, _deps: ServerDeps): void {
  ws.on('message', async (raw) => {
    let parsed: { type: string; text?: string };
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    if (parsed.type === 'chat.send' && parsed.text) {
      const text = parsed.text;
      const msgId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      try {
        // Store user message — the message loop picks it up like Telegram/WhatsApp
        storeChatMessage({
          id: msgId,
          chat_jid: WEB_CHAT_JID,
          sender: 'web-user',
          sender_name: 'Web User',
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: false,
        });
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'chat.error',
          error: `Failed to store message: ${err instanceof Error ? err.message : 'Unknown'}`,
        }));
        return;
      }

      // Acknowledge receipt — response comes back via WebUIChannel.sendMessage → broadcast
      ws.send(JSON.stringify({ type: 'chat.ack', id: msgId }));
    }
  });
}
