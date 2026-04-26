import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

import { logger } from '../logger.js';
import { redactSensitiveData } from '../redact.js';
import {
  getChatAgentToken,
  getChatRoom,
  getChatRooms,
  getChatMessages,
  storeChatMessage,
  deleteChatMessage,
} from '../chat-db.js';
import { authenticateRequest } from './auth.js';
import {
  WSClient,
  clients,
  addClient,
  removeClient,
  broadcast,
  getMemberList,
  getOnNewMessage,
} from './state.js';

export function setupWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  // Ping/pong keepalive — detect stale connections
  const WS_PING_INTERVAL = 30_000;
  const pingTimer = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.isAlive) {
        c.ws.terminate();
        removeClient(c.id);
        continue;
      }
      c.isAlive = false;
      c.ws.ping();
    }
  }, WS_PING_INTERVAL);
  wss.on('close', () => clearInterval(pingTimer));

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const auth = await authenticateRequest(req);
    if (!auth.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket as any, head, (ws) => {
      (req as any)._authIdentity = auth.identity;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const clientId = randomUUID();
    const remoteIp = (req.socket.remoteAddress ?? '127.0.0.1').replace(
      /^::ffff:/,
      '',
    );

    const client: WSClient = {
      id: clientId,
      ws,
      identity: 'unauthenticated',
      identity_type: 'user',
      isAlive: true,
    };
    addClient(client);

    ws.on('pong', () => {
      client.isAlive = true;
    });
    ws.on('error', (err) => {
      logger.warn(
        { clientId, identity: client.identity, error: err.message },
        'WebSocket client error',
      );
    });

    let authenticated = false;

    const send = (data: object) => ws.send(JSON.stringify(data));

    ws.on('message', async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: 'error', error: 'Invalid JSON' });
        return;
      }

      // ── AUTH ────────────────────────────────────────────────────────────
      if (msg.type === 'auth') {
        if (msg.token) {
          const agent = getChatAgentToken(msg.token);
          if (!agent) {
            send({ type: 'error', error: 'Invalid token' });
            return;
          }
          client.identity = agent.agent_id;
          client.identity_type = 'agent';
        } else {
          // Use identity from upgrade auth (token, localhost, proxy, or tailscale)
          const upgradeIdentity = (req as any)._authIdentity as
            | string
            | undefined;
          client.identity = upgradeIdentity || `user@${remoteIp}`;
          client.identity_type = 'user';
        }
        authenticated = true;
        send({ type: 'system', message: `Connected as ${client.identity}` });
        send({ type: 'rooms', rooms: getChatRooms() });
        return;
      }

      if (!authenticated) {
        send({ type: 'error', error: 'Not authenticated' });
        return;
      }

      // ── JOIN ─────────────────────────────────────────────────────────────
      if (msg.type === 'join') {
        const room = getChatRoom(msg.room_id);
        if (!room) {
          send({ type: 'error', error: `Room not found: ${msg.room_id}` });
          return;
        }
        client.room_id = room.id;
        send({
          type: 'history',
          room_id: room.id,
          messages: getChatMessages(room.id, 50).map((m) => ({
            ...m,
            content: redactSensitiveData(m.content),
          })),
        });
        broadcast(
          room.id,
          {
            type: 'system',
            room_id: room.id,
            message: `${client.identity} joined`,
          },
          clientId,
        );
        broadcast(room.id, {
          type: 'members',
          room_id: room.id,
          members: getMemberList(room.id),
        });
        return;
      }

      // ── TYPING ───────────────────────────────────────────────────────────
      if (msg.type === 'typing') {
        if (!client.room_id) return;
        broadcast(
          client.room_id,
          {
            type: 'typing',
            room_id: client.room_id,
            identity: client.identity,
            identity_type: client.identity_type,
            is_typing: !!msg.is_typing,
          },
          clientId,
        );
        return;
      }

      // ── MESSAGE ───────────────────────────────────────────────────────────
      if (msg.type === 'message') {
        if (!client.room_id) {
          send({ type: 'error', error: 'Join a room first' });
          return;
        }
        if (!msg.content?.trim()) return;
        const stored = storeChatMessage(
          client.room_id,
          client.identity,
          client.identity_type,
          msg.content,
        );
        const outgoing: Record<string, unknown> = {
          type: 'message',
          ...stored,
        };
        if (msg.client_id) outgoing.client_id = msg.client_id;
        broadcast(client.room_id, outgoing, clientId);
        const onNewMessage = getOnNewMessage();
        if (onNewMessage && client.identity_type === 'user') {
          onNewMessage(client.room_id, stored);
        }
        send({ ...outgoing, content: redactSensitiveData(stored.content) });
        return;
      }

      // ── DELETE MESSAGE ──────────────────────────────────────────────────
      if (msg.type === 'delete_message') {
        if (!client.room_id) return;
        if (!msg.message_id) {
          send({ type: 'error', error: 'message_id required' });
          return;
        }
        const deleted = deleteChatMessage(msg.message_id, client.identity);
        if (deleted) {
          broadcast(client.room_id, {
            type: 'delete_message',
            room_id: client.room_id,
            message_id: msg.message_id,
          });
          send({
            type: 'delete_message',
            room_id: client.room_id,
            message_id: msg.message_id,
          });
        }
        return;
      }
    });

    ws.on('close', () => {
      const c = removeClient(clientId);
      if (c?.room_id) {
        broadcast(c.room_id, {
          type: 'system',
          room_id: c.room_id,
          message: `${c.identity} left`,
        });
        broadcast(c.room_id, {
          type: 'members',
          room_id: c.room_id,
          members: getMemberList(c.room_id),
        });
      }
    });
  });
}
