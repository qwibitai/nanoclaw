/**
 * Runner Registry
 *
 * WebSocket server at /runner/connect. Handles runner registration,
 * heartbeat, message dispatch, and tool-call proxying.
 *
 * Central interacts with remote agents exclusively through this module —
 * no runner-internal state leaks into the router or delivery layers.
 */
import crypto from 'crypto';
import http from 'http';

import { WebSocketServer, WebSocket } from 'ws';

import { RUNNER_WS_PORT } from './config.js';
import { getDb } from './db/connection.js';
import { log } from './log.js';
import {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  makeFrame,
  type Frame,
  type MessageType,
  type RunnerRegisterPayload,
  type RunnerAckPayload,
  type HeartbeatPayload,
  type HeartbeatAckPayload,
  type ToolCallProxyPayload,
  type ToolResultProxyPayload,
  type ResponsePayload,
  type MessageAckPayload,
  type StaleToolResultPayload,
  type ErrorPayload,
  type ErrorCode,
  type RunnerConfig,
  type InboundMessagePayload,
  type ReplayEndPayload,
  type GapNoticePayload,
  type TokenRotateAckPayload,
  type TokenInvalidatePayload,
  type ClaudeInvokePayload,
  type ClaudeResultPayload,
} from './runner-protocol.js';

// ── Replay buffer ─────────────────────────────────────────────────────────────

const REPLAY_BUFFER_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface BufferedFrame {
  seq: number;
  json: string;
  queuedAt: number;
}

// ── Per-runner connection state ───────────────────────────────────────────────

interface RunnerConn {
  runnerId: string;
  runnerName: string;
  sessionId: string;
  ws: WebSocket;
  /** Monotonic counter for frames we send to this runner. */
  outSeq: number;
  /** Last seq the runner has acked (via last_acked_seq on inbound frames). */
  lastRunnerAckedSeq: number;
  /** Last seq we received from the runner. */
  lastInboundSeq: number;
  /** Outbound replay buffer: seq → buffered frame. */
  replayBuffer: Map<number, BufferedFrame>;
  /** True while replaying on reconnect — new INBOUND_MESSAGEs are buffered. */
  replaying: boolean;
  /** INBOUND_MESSAGEs buffered during replay phase. */
  pendingInbound: InboundMessagePayload[];
}

// ── Registry ──────────────────────────────────────────────────────────────────

/** Active connections keyed by runner_id. */
const connections = new Map<string, RunnerConn>();

/** Tool-call result waiters: call_id → resolve fn. */
const toolWaiters = new Map<string, (result: ToolResultProxyPayload) => void>();

/** CLAUDE_INVOKE result waiters: correlation_id → resolve/reject/timer. */
const claudeInvokeWaiters = new Map<
  string,
  {
    resolve: (result: ClaudeResultPayload) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

// ── Token hashing + minting ───────────────────────────────────────────────────

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function mintCredential(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ── Frame helpers ─────────────────────────────────────────────────────────────

function sendFrame(conn: RunnerConn, type: MessageType, payload: unknown): void {
  conn.outSeq++;
  const frame = makeFrame(type, payload, conn.outSeq, conn.lastInboundSeq, conn.sessionId);
  const json = JSON.stringify(frame);

  // Buffer for replay before sending.
  conn.replayBuffer.set(conn.outSeq, {
    seq: conn.outSeq,
    json,
    queuedAt: Date.now(),
  });

  if (conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(json);
  }
}

function sendError(ws: WebSocket, code: ErrorCode, message: string, fatal: boolean, refSeq?: number): void {
  const payload: ErrorPayload = { code, message, fatal, ref_seq: refSeq };
  const frame: Frame = { type: 'ERROR', seq: 0, last_acked_seq: 0, session_id: '', payload };
  ws.send(JSON.stringify(frame));
  if (fatal) ws.close();
}

function evictStaleReplayFrames(conn: RunnerConn): void {
  const cutoff = Date.now() - REPLAY_BUFFER_TTL_MS;
  for (const [seq, frame] of conn.replayBuffer) {
    if (frame.queuedAt < cutoff) conn.replayBuffer.delete(seq);
  }
}

// ── Runner DB helpers ─────────────────────────────────────────────────────────

interface RunnerRow {
  id: string;
  name: string;
  runner_type: string;
  runner_token_hash: string | null;
  bootstrap_token_hash: string | null;
  bootstrap_expires_at: string | null;
  bootstrap_used_at: string | null;
  credential_hash: string | null;
  credential_rotated_at: string | null;
  status: string;
}

function getRunnerByName(name: string): RunnerRow | undefined {
  return getDb().prepare('SELECT * FROM runners WHERE name = ?').get(name) as RunnerRow | undefined;
}

function upsertRunnerStatus(id: string, status: string, version: string, protocol: string): void {
  getDb()
    .prepare(`UPDATE runners SET status = ?, last_heartbeat = ?, runner_version = ?, protocol_version = ? WHERE id = ?`)
    .run(status, new Date().toISOString(), version, protocol, id);
}

function getAssignedAgents(runnerId: string): RunnerConfig {
  const db = getDb();
  const groups = db
    .prepare(
      `SELECT ag.id, ag.folder, cc.model, cc.mcp_servers
       FROM agent_groups ag
       LEFT JOIN container_configs cc ON cc.agent_group_id = ag.id
       WHERE ag.runner_id = ?`,
    )
    .all(runnerId) as Array<{ id: string; folder: string; model: string | null; mcp_servers: string }>;

  return {
    remote_agents: groups.map((g) => ({
      remote_agent_id: g.id,
      runner_id: runnerId,
      model: g.model ?? 'claude-opus-4-5',
      instructions: '',
      mcp_servers: (() => {
        if (!g.mcp_servers) return [];
        const parsed = JSON.parse(g.mcp_servers) as unknown;
        if (!Array.isArray(parsed)) return [];
        return (parsed as Record<string, unknown>[]).map((s: Record<string, unknown>) => ({
          name: String(s.name ?? ''),
          command: String(s.command ?? ''),
          args: (s.args as string[]) ?? [],
          env: s.env as Record<string, string> | undefined,
          local: Boolean(s.local ?? false),
        }));
      })(),
      workspace_path: `/workspace/groups/${g.folder}`,
    })),
  };
}

// ── Registration handler ──────────────────────────────────────────────────────

function handleRegister(ws: WebSocket, frame: Frame<'RUNNER_REGISTER', RunnerRegisterPayload>): void {
  const p = frame.payload;

  if (!SUPPORTED_PROTOCOL_VERSIONS.has(p.protocol_version)) {
    sendError(ws, 'AUTH_FAILED', `Unsupported protocol version: ${p.protocol_version}`, true);
    return;
  }

  const runner = getRunnerByName(p.runner_name);
  if (!runner) {
    sendError(ws, 'AUTH_FAILED', 'Unknown runner name', true);
    return;
  }

  const authType = p.auth_type ?? 'credential';
  let credentialForAck: string | undefined;

  if (authType === 'bootstrap') {
    if (!runner.bootstrap_token_hash) {
      sendError(ws, 'AUTH_FAILED', 'No bootstrap token set for this runner', true);
      return;
    }
    if (runner.bootstrap_used_at) {
      sendError(ws, 'AUTH_FAILED', 'Bootstrap token already used', true);
      return;
    }
    if (runner.bootstrap_expires_at && new Date(runner.bootstrap_expires_at) < new Date()) {
      sendError(ws, 'AUTH_FAILED', 'Bootstrap token expired', true);
      return;
    }
    if (runner.bootstrap_token_hash !== hashToken(p.runner_token)) {
      sendError(ws, 'AUTH_FAILED', 'Invalid bootstrap token', true);
      return;
    }
    // Consume bootstrap, mint long-lived credential.
    credentialForAck = mintCredential();
    getDb()
      .prepare(
        `UPDATE runners
         SET bootstrap_used_at = ?, credential_hash = ?
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), hashToken(credentialForAck), runner.id);
    log.info('Bootstrap consumed — credential minted', { runnerId: runner.id });
  } else {
    // Credential auth: check credential_hash first, fall back to legacy runner_token_hash.
    const validHash = runner.credential_hash ?? runner.runner_token_hash;
    if (!validHash || validHash !== hashToken(p.runner_token)) {
      sendError(ws, 'AUTH_FAILED', 'Invalid runner token', true);
      return;
    }
  }

  // Close any existing connection for this runner.
  const existing = connections.get(runner.id);
  if (existing) {
    log.info('Runner reconnecting — closing old connection', { runnerId: runner.id });
    existing.ws.close();
    connections.delete(runner.id);
  }

  const sessionId = crypto.randomUUID();
  const conn: RunnerConn = {
    runnerId: runner.id,
    runnerName: runner.name,
    sessionId,
    ws,
    outSeq: 0,
    lastRunnerAckedSeq: 0,
    lastInboundSeq: frame.seq,
    replayBuffer: new Map(),
    replaying: false,
    pendingInbound: [],
  };
  connections.set(runner.id, conn);

  // Determine replay range.
  let replayFromSeq = 0;
  let replayedCount = 0;
  const lastInbound = p.last_inbound_seq;

  if (lastInbound > 0) {
    // Find the first frame in our buffer after what they last saw.
    const framesToReplay: BufferedFrame[] = [];
    evictStaleReplayFrames(conn);

    for (const [seq, bf] of conn.replayBuffer) {
      if (seq > lastInbound) framesToReplay.push(bf);
    }
    framesToReplay.sort((a, b) => a.seq - b.seq);

    if (framesToReplay.length > 0) {
      replayFromSeq = framesToReplay[0].seq;
      const gapStart = framesToReplay[0].seq;

      // Check if there's a gap (evicted frames).
      const expectedFirst = lastInbound + 1;
      if (gapStart > expectedFirst) {
        // Some frames were evicted — send GAP_NOTICE before replay.
        const gapPayload: GapNoticePayload = {
          first_available_seq: gapStart,
          dropped_count: gapStart - expectedFirst,
          gap_start: new Date(Date.now() - REPLAY_BUFFER_TTL_MS).toISOString(),
        };
        conn.outSeq++;
        const gapFrame = makeFrame('GAP_NOTICE', gapPayload, conn.outSeq, conn.lastInboundSeq, sessionId);
        ws.send(JSON.stringify(gapFrame));
      }

      conn.replaying = true;
      for (const bf of framesToReplay) {
        ws.send(bf.json);
        replayedCount++;
      }
    }
  }

  // Send RUNNER_ACK.
  const config = getAssignedAgents(runner.id);
  const ackPayload: RunnerAckPayload = {
    runner_id: runner.id,
    session_id: sessionId,
    config_snapshot: config,
    replay_from_seq: replayFromSeq,
    credential: credentialForAck,
  };
  sendFrame(conn, 'RUNNER_ACK', ackPayload);

  // If we replayed frames, send REPLAY_END.
  if (replayFromSeq > 0) {
    const replayEndPayload: ReplayEndPayload = { replayed_count: replayedCount };
    sendFrame(conn, 'REPLAY_END', replayEndPayload);
    conn.replaying = false;
    // Flush buffered inbound messages.
    for (const pending of conn.pendingInbound) {
      sendFrame(conn, 'INBOUND_MESSAGE', pending);
    }
    conn.pendingInbound = [];
  }

  upsertRunnerStatus(runner.id, 'connected', p.runner_version, p.protocol_version);

  log.info('Runner registered', {
    runnerId: runner.id,
    name: runner.name,
    version: p.runner_version,
    replayedCount,
  });
}

// ── Inbound frame dispatcher ──────────────────────────────────────────────────

function handleFrame(conn: RunnerConn, raw: string): void {
  let frame: Frame;
  try {
    frame = JSON.parse(raw) as Frame;
  } catch {
    sendError(conn.ws, 'INVALID_FRAME', 'Invalid JSON', false);
    return;
  }

  // Update last_acked_seq: runner is telling us which of our frames it has seen.
  if (frame.last_acked_seq > conn.lastRunnerAckedSeq) {
    conn.lastRunnerAckedSeq = frame.last_acked_seq;
    // Evict acked frames from replay buffer.
    for (const seq of conn.replayBuffer.keys()) {
      if (seq <= conn.lastRunnerAckedSeq) conn.replayBuffer.delete(seq);
    }
  }

  conn.lastInboundSeq = frame.seq;

  switch (frame.type as MessageType) {
    case 'HEARTBEAT':
      handleHeartbeat(conn, frame as Frame<'HEARTBEAT', HeartbeatPayload>);
      break;
    case 'MESSAGE_ACK':
      handleMessageAck(conn, frame as Frame<'MESSAGE_ACK', MessageAckPayload>);
      break;
    case 'TOOL_CALL_PROXY':
      handleToolCallProxy(conn, frame as Frame<'TOOL_CALL_PROXY', ToolCallProxyPayload>).catch((err) => {
        log.error('TOOL_CALL_PROXY handler threw', { err });
      });
      break;
    case 'RESPONSE':
      handleResponse(conn, frame as Frame<'RESPONSE', ResponsePayload>);
      break;
    case 'STALE_TOOL_RESULT':
      handleStaleToolResult(conn, frame as Frame<'STALE_TOOL_RESULT', StaleToolResultPayload>);
      break;
    case 'TOKEN_ROTATE_REQUEST':
      handleTokenRotateRequest(conn);
      break;
    case 'CLAUDE_RESULT': {
      const p = frame.payload as ClaudeResultPayload;
      const waiter = claudeInvokeWaiters.get(p.correlation_id);
      if (waiter) {
        clearTimeout(waiter.timer);
        claudeInvokeWaiters.delete(p.correlation_id);
        waiter.resolve(p);
      }
      break;
    }
    default:
      sendError(conn.ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown type: ${frame.type}`, false);
  }
}

function handleHeartbeat(conn: RunnerConn, frame: Frame<'HEARTBEAT', HeartbeatPayload>): void {
  const p = frame.payload;
  upsertRunnerStatus(conn.runnerId, 'connected', p.runner_version, PROTOCOL_VERSION);
  log.debug('Runner heartbeat', {
    runnerId: conn.runnerId,
    agentsRunning: p.agents_running,
    errors: p.errors.length,
  });

  const ack: HeartbeatAckPayload = {
    runner_status: 'connected',
    server_time: new Date().toISOString(),
  };
  sendFrame(conn, 'HEARTBEAT_ACK', ack);
}

function handleMessageAck(conn: RunnerConn, frame: Frame<'MESSAGE_ACK', MessageAckPayload>): void {
  log.debug('Runner acked message', {
    runnerId: conn.runnerId,
    messageId: frame.payload.message_id,
  });
}

async function handleToolCallProxy(
  conn: RunnerConn,
  frame: Frame<'TOOL_CALL_PROXY', ToolCallProxyPayload>,
): Promise<void> {
  const { call_id, tool_name, tool_input } = frame.payload;
  log.debug('TOOL_CALL_PROXY', { runnerId: conn.runnerId, callId: call_id, toolName: tool_name });

  // Tool-call execution is handled by the NanoClaw MCP tool layer.
  // The actual dispatch is wired in index.ts via registerToolCallHandler.
  const handler = toolCallHandlers.get(tool_name);
  if (!handler) {
    const result: ToolResultProxyPayload = {
      call_id,
      remote_agent_id: frame.payload.remote_agent_id,
      tool_name,
      result: {},
      error: { code: 'TOOL_NOT_FOUND', message: `No handler registered for tool: ${tool_name}` },
    };
    sendFrame(conn, 'TOOL_RESULT_PROXY', result);
    return;
  }

  try {
    const output = await handler(frame.payload);
    const result: ToolResultProxyPayload = {
      call_id,
      remote_agent_id: frame.payload.remote_agent_id,
      tool_name,
      result: output,
    };
    sendFrame(conn, 'TOOL_RESULT_PROXY', result);
  } catch (err) {
    const result: ToolResultProxyPayload = {
      call_id,
      remote_agent_id: frame.payload.remote_agent_id,
      tool_name,
      result: {},
      error: { code: 'TOOL_EXECUTION_ERROR', message: String(err) },
    };
    sendFrame(conn, 'TOOL_RESULT_PROXY', result);
  }
}

function handleResponse(conn: RunnerConn, frame: Frame<'RESPONSE', ResponsePayload>): void {
  const p = frame.payload;
  log.info('Runner turn complete', {
    runnerId: conn.runnerId,
    agentId: p.remote_agent_id,
    messageId: p.turn_message_id,
    durationMs: p.turn_stats?.duration_ms,
  });
  // Dispatch to registered response handlers (wired in index.ts).
  for (const handler of responseHandlers) {
    try {
      handler(conn.runnerId, p);
    } catch (err) {
      log.error('Response handler threw', { err });
    }
  }
}

function handleTokenRotateRequest(conn: RunnerConn): void {
  const newCredential = mintCredential();
  getDb()
    .prepare(`UPDATE runners SET credential_hash = ?, credential_rotated_at = ? WHERE id = ?`)
    .run(hashToken(newCredential), new Date().toISOString(), conn.runnerId);

  log.info('Runner credential rotated', { runnerId: conn.runnerId, runnerName: conn.runnerName });

  const ack: TokenRotateAckPayload = { new_credential: newCredential };
  sendFrame(conn, 'TOKEN_ROTATE_ACK', ack);
}

function handleStaleToolResult(conn: RunnerConn, frame: Frame<'STALE_TOOL_RESULT', StaleToolResultPayload>): void {
  log.info('Stale tool result discarded by runner', {
    runnerId: conn.runnerId,
    callId: frame.payload.call_id,
    turnMessageId: frame.payload.turn_message_id,
  });
}

// ── Tool-call and response handler registries ─────────────────────────────────

type ToolCallHandler = (payload: ToolCallProxyPayload) => Promise<Record<string, unknown>>;
type RunnerResponseHandler = (runnerId: string, payload: ResponsePayload) => void;

const toolCallHandlers = new Map<string, ToolCallHandler>();
const responseHandlers: RunnerResponseHandler[] = [];

export function registerToolCallHandler(toolName: string, handler: ToolCallHandler): void {
  toolCallHandlers.set(toolName, handler);
}

export function registerRunnerResponseHandler(handler: RunnerResponseHandler): void {
  responseHandlers.push(handler);
}

// ── CLAUDE_INVOKE: send to runner and await CLAUDE_RESULT ─────────────────────

export async function sendClaudeInvoke(runnerId: string, payload: ClaudeInvokePayload): Promise<ClaudeResultPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        claudeInvokeWaiters.delete(payload.correlation_id);
        reject(new Error('CLAUDE_INVOKE timeout after 30 minutes'));
      },
      30 * 60 * 1000,
    );
    claudeInvokeWaiters.set(payload.correlation_id, { resolve, reject, timer });
    const conn = connections.get(runnerId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      clearTimeout(timer);
      claudeInvokeWaiters.delete(payload.correlation_id);
      reject(new Error(`Runner ${runnerId} is not connected`));
      return;
    }
    sendFrame(conn, 'CLAUDE_INVOKE', payload);
  });
}

// ── Dispatch: send INBOUND_MESSAGE to a runner ────────────────────────────────

export function dispatchToRunner(runnerId: string, payload: InboundMessagePayload): boolean {
  const conn = connections.get(runnerId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  if (conn.replaying) {
    conn.pendingInbound.push(payload);
  } else {
    sendFrame(conn, 'INBOUND_MESSAGE', payload);
  }
  return true;
}

/** Push TOKEN_INVALIDATE to a runner's live connection, if any. */
export function sendTokenInvalidate(runnerId: string, reason: TokenInvalidatePayload['reason'] = 'revoked'): void {
  const conn = connections.get(runnerId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;
  const payload: TokenInvalidatePayload = { reason };
  sendFrame(conn, 'TOKEN_INVALIDATE', payload);
  log.info('TOKEN_INVALIDATE sent', { runnerId, reason });
}

export function isRunnerConnected(runnerId: string): boolean {
  const conn = connections.get(runnerId);
  return !!conn && conn.ws.readyState === WebSocket.OPEN;
}

// ── Server startup ────────────────────────────────────────────────────────────

let server: http.Server | null = null;

export function startRunnerRegistry(): void {
  server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/runner/connect' });

  wss.on('connection', (ws) => {
    let conn: RunnerConn | null = null;
    let registered = false;

    ws.on('message', (data) => {
      const raw = data.toString();

      if (!registered) {
        // First message must be RUNNER_REGISTER.
        let frame: Frame<'RUNNER_REGISTER', RunnerRegisterPayload>;
        try {
          frame = JSON.parse(raw) as Frame<'RUNNER_REGISTER', RunnerRegisterPayload>;
        } catch {
          sendError(ws, 'INVALID_FRAME', 'Invalid JSON', true);
          return;
        }
        if (frame.type !== 'RUNNER_REGISTER') {
          sendError(ws, 'AUTH_FAILED', 'First message must be RUNNER_REGISTER', true);
          return;
        }
        handleRegister(ws, frame);
        conn = Array.from(connections.values()).find((c) => c.ws === ws) ?? null;
        if (conn) registered = true;
        return;
      }

      if (conn) handleFrame(conn, raw);
    });

    ws.on('close', () => {
      if (conn) {
        log.info('Runner disconnected', { runnerId: conn.runnerId });
        // Don't remove from connections map — keeps replay buffer alive for reconnect.
        getDb().prepare("UPDATE runners SET status = 'disconnected' WHERE id = ?").run(conn.runnerId);
      }
    });

    ws.on('error', (err) => {
      log.warn('Runner WebSocket error', { runnerId: conn?.runnerId, err });
    });
  });

  server.listen(RUNNER_WS_PORT, () => {
    log.info('Runner registry listening', { port: RUNNER_WS_PORT });
  });
}

export function stopRunnerRegistry(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    // Close active runner connections so server.close() resolves promptly.
    for (const conn of connections.values()) {
      conn.ws.close(1001, 'server shutting down');
    }
    server.close(() => resolve());
  });
}
