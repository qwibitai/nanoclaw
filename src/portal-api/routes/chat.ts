/**
 * Chat routes — WebSocket and REST for agent communication.
 */
import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

import { logger } from '../../logger.js';
import { verifyToken } from '../middleware/auth.js';
import {
  getAgent,
  getChatHistory,
  storeChatMessage,
  logActivity,
} from '../db-portal.js';
import { json, error, RequestContext } from '../server.js';

interface ChatClient {
  ws: WebSocket;
  userId: string;
  agentId: string;
}

const clients: ChatClient[] = [];
let wss: WebSocketServer | null = null;

// Callback for agent responses — set by portal channel integration
let onAgentResponse: ((agentId: string, message: string) => void) | null = null;

export function setAgentResponseHandler(
  handler: (agentId: string, message: string) => void,
): void {
  onAgentResponse = handler;
}

/**
 * Broadcast a message to all WebSocket clients subscribed to an agent.
 */
export function broadcastToAgent(agentId: string, message: string, direction: 'inbound' | 'outbound' = 'outbound'): void {
  const payload = JSON.stringify({
    type: 'message',
    agent_id: agentId,
    direction,
    content: message,
    timestamp: new Date().toISOString(),
  });

  for (const client of clients) {
    if (client.agentId === agentId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

/**
 * Broadcast activity updates to all connected dashboard clients.
 */
export function broadcastActivity(activity: unknown): void {
  const payload = JSON.stringify({ type: 'activity', data: activity });
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

export function initChatWebSocket(server: Server): void {
  // ws is an optional dependency — gracefully skip if not available
  try {
    // Dynamic import check — ws may not be installed yet
    wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws, req) => {
      // Authenticate via query param token
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (!token) {
        ws.close(1008, 'Authentication required');
        return;
      }

      const user = verifyToken(token);
      if (!user) {
        ws.close(1008, 'Invalid token');
        return;
      }

      const agentId = url.searchParams.get('agent_id') || '';
      const client: ChatClient = { ws, userId: user.sub, agentId };
      clients.push(client);

      logger.info(
        { userId: user.sub, agentId },
        'WebSocket client connected',
      );

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'subscribe' && msg.agent_id) {
            client.agentId = msg.agent_id;
            return;
          }

          if (msg.type === 'message' && msg.agent_id && msg.content) {
            // Store the inbound message
            storeChatMessage({
              agent_id: msg.agent_id,
              user_id: user.sub,
              direction: 'inbound',
              content: msg.content,
            });

            // Forward to agent processing
            if (onAgentResponse) {
              onAgentResponse(msg.agent_id, msg.content);
            }

            // Log activity
            logActivity({
              agent_id: msg.agent_id,
              ticket_id: null,
              ticket_display_id: null,
              action_type: 'chat',
              detail: JSON.stringify({ from: 'portal', content: msg.content.slice(0, 200) }),
              client_id: null,
              duration_ms: null,
            });
          }
        } catch (err) {
          logger.warn({ err }, 'Invalid WebSocket message');
        }
      });

      ws.on('close', () => {
        const idx = clients.indexOf(client);
        if (idx >= 0) clients.splice(idx, 1);
      });
    });

    logger.info('WebSocket server initialized for chat');
  } catch (err) {
    logger.warn({ err }, 'WebSocket initialization failed (ws module may not be installed)');
  }
}

export async function handleChatRoutes(ctx: RequestContext): Promise<void> {
  const { method, pathname, body, res } = ctx;

  // POST /api/chat/:agentId — Send message to agent
  const sendMatch = pathname.match(/^\/api\/chat\/([^/]+)$/);
  if (method === 'POST' && sendMatch) {
    const agentId = sendMatch[1];
    const agent = getAgent(agentId);
    if (!agent) {
      error(res, 'Agent not found', 404);
      return;
    }

    const data = body as { content: string } | null;
    if (!data?.content) {
      error(res, 'content is required');
      return;
    }

    // Store message
    const msg = storeChatMessage({
      agent_id: agentId,
      user_id: ctx.user!.sub,
      direction: 'inbound',
      content: data.content,
    });

    // Broadcast to WebSocket clients
    broadcastToAgent(agentId, data.content, 'inbound');

    // Forward to agent
    if (onAgentResponse) {
      onAgentResponse(agentId, data.content);
    }

    json(res, msg, 201);
    return;
  }

  // GET /api/chat/:agentId/history
  const historyMatch = pathname.match(/^\/api\/chat\/([^/]+)\/history$/);
  if (method === 'GET' && historyMatch) {
    const agentId = historyMatch[1];
    const limit = parseInt(ctx.url.searchParams.get('limit') || '100', 10);
    const messages = getChatHistory(agentId, limit);
    json(res, messages);
    return;
  }

  error(res, 'Not Found', 404);
}
