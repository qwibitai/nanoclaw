import type { Channel } from '../types.js';
import { broadcast } from '../webui/ws.js';
import { storeChatMessage } from '../db.js';

const WEB_CHAT_JID = 'web@chat';

/**
 * WebUI channel — treats the browser WebSocket chat as a standard NanoClaw
 * channel, just like Telegram or WhatsApp. Messages flow through the same
 * processGroupMessages → runAgent → IPC send_message path.
 */
export class WebUIChannel implements Channel {
  name = 'webui';

  async connect(): Promise<void> {
    // No connection needed — WebSocket clients connect via the HTTP server
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (jid !== WEB_CHAT_JID) return;

    // Store the assistant response in the DB (for chat history)
    try {
      storeChatMessage({
        id: `web-resp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        chat_jid: WEB_CHAT_JID,
        sender: 'assistant',
        sender_name: 'Assistant',
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: true,
      });
    } catch { /* best-effort */ }

    // Broadcast to all connected WebSocket clients
    broadcast({ type: 'chat.done', text });
  }

  isConnected(): boolean {
    return true;
  }

  ownsJid(jid: string): boolean {
    return jid === WEB_CHAT_JID;
  }

  async disconnect(): Promise<void> {
    // Nothing to disconnect
  }
}
