// Outbound ACP client — delegates prompts to remote Zed Agent Client Protocol
// peers (e.g. Claude Code via `@agentclientprotocol/claude-agent-acp`).
//
// Transport: exposes core ACP conversation primitives as HTTP actions via
// `agent.action()`. The in-VM model drives the ACP state machine by calling
// `search_actions({query: "acp"})` to discover, then `call_action(...)` to
// invoke, using the existing PR #44 http-actions infrastructure.
//
// Five actions get registered per agent (when options.acp.peers is set):
//
//   acp_list_remote_agents — directory snapshot
//   acp_new_session        — create a session on a peer
//   acp_prompt             — send PromptRequest in the background
//   acp_cancel             — session/cancel notification
//   acp_close_session      — drop local session tracking
//
// Peer child processes are lazy-spawned on first use, reused across sessions,
// and killed on agent.stop(). The host holds session accumulators in-memory,
// writes per-prompt result artifacts into the caller's group IPC mount, and
// injects a compact completion notice back into the caller chat.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { z } from 'zod';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

import type { Agent } from '../api/agent.js';
import type { ActionContext } from '../api/action.js';
import { logger } from '../logger.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../group-folder.js';

import type { AcpPeerConfig, AcpPeerDirectoryEntry } from './types.js';

/** Dependencies the outbound client needs from the host. */
export interface AcpOutboundDeps {
  peers: AcpPeerConfig[];
  groupsDir: string;
  dataDir: string;
  resolveCallerChatJid: (ctx: ActionContext) => string;
  injectNotice: (chatJid: string, text: string) => Promise<void> | void;
}

/** Internal per-peer state. */
interface PeerState {
  config: AcpPeerConfig;
  /** null until first spawn; reset on crash. */
  child: ChildProcess | null;
  /** Connection object wrapping child stdio. */
  connection: ClientSideConnection | null;
  /** Resolved after successful initialize. */
  agentInfo: { name: string; version: string; title?: string | null } | null;
  /** Single-flight guard so concurrent callers don't spawn the same peer twice. */
  spawnPromise: Promise<void> | null;
}

/** Accumulates session/update notifications for a single in-flight prompt. */
interface SessionAccumulator {
  text: string[];
  toolCalls: unknown[];
}

/** Per-session state, keyed globally by Zed sessionId. */
interface SessionState {
  peer: string;
  callerGroupFolder: string;
  callerChatJid: string;
  createdAt: number;
  /** Set during an in-flight acp_prompt; null otherwise. */
  accumulator: SessionAccumulator | null;
  activeRunId: string | null;
}

type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

interface PendingRun {
  id: string;
  sessionId: string;
  peer: string;
  callerGroupFolder: string;
  callerChatJid: string;
  startedAt: string;
  hostPath: string;
  containerPath: string;
}

interface AcpRunArtifact {
  session_id: string;
  peer: string;
  status: RunStatus;
  stop_reason?: string;
  started_at: string;
  completed_at?: string;
  text: string;
  tool_calls: unknown[];
  text_bytes: number;
  tool_call_count: number;
  error?: string;
}

const ACP_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ACP_RUN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// ACP ContentBlock — inline discriminated union matching the spec.
// We accept the full shape; the peer errors if a kind exceeds its advertised
// promptCapabilities.
const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    type: z.literal('audio'),
    data: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    type: z.literal('resource_link'),
    uri: z.string(),
    name: z.string(),
  }),
]);

export class AcpOutboundClient {
  private readonly peers = new Map<string, PeerState>();
  /** Active sessions keyed by Zed sessionId. */
  private readonly sessions = new Map<string, SessionState>();
  /** Active background prompts keyed by internal run id. */
  private readonly pendingRuns = new Map<string, PendingRun>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: AcpOutboundDeps) {
    for (const peer of deps.peers) {
      this.peers.set(peer.name, {
        config: peer,
        child: null,
        connection: null,
        agentInfo: null,
        spawnPromise: null,
      });
    }
    this.recoverAbandonedArtifacts();
    this.sweepExpiredArtifacts();
    if (ACP_RUN_SWEEP_INTERVAL_MS > 0) {
      this.sweepTimer = setInterval(
        () => this.sweepExpiredArtifacts(),
        ACP_RUN_SWEEP_INTERVAL_MS,
      );
      this.sweepTimer.unref?.();
    }
  }

  /** Public peer directory snapshot. */
  listPeers(): AcpPeerDirectoryEntry[] {
    return Array.from(this.peers.values()).map((p) => ({
      name: p.config.name,
      description: p.config.description,
      agent_info: p.agentInfo,
    }));
  }

  /**
   * Register the five core ACP conversation primitives as HTTP actions on
   * the given agent. Called during `AgentImpl.startSubsystems()` after the
   * existing `actionsHttp` is wired up.
   */
  registerActions(agent: Agent): void {
    agent.action(
      'acp_list_remote_agents',
      'List configured remote ACP agents this host can delegate to. Returns an array of entries with name, description, and (after the first acp_new_session) the peer-reported agent_info.',
      {},
      async () => ({ agents: this.listPeers() }),
    );

    agent.action(
      'acp_new_session',
      'Create a new ACP conversation session with a remote peer. Returns a session_id that subsequent acp_prompt / acp_cancel / acp_close_session calls must reference. The peer sees this as the start of a fresh conversation.',
      {
        peer: z.string().describe('Peer name from acp_list_remote_agents'),
        cwd: z
          .string()
          .optional()
          .describe(
            'Absolute path the peer should treat as its working directory. Defaults to the caller group workdir.',
          ),
      },
      async (args, ctx) => this.handleNewSession(args, ctx),
    );

    agent.action(
      'acp_prompt',
      'Send an ACP PromptRequest to an active session in the background. Returns immediately with { ok: true }. When the peer finishes, AgentLite injects a notice back into the caller chat containing the terminal status and the result artifact path. Do not poll for the result.\n\nThe prompt is an array of ACP ContentBlocks — the spec shape. For a plain text task: [{"type":"text","text":"your task here"}]. Image/audio/resource_link blocks are supported if the peer advertised the matching promptCapabilities.',
      {
        session_id: z
          .string()
          .describe('The session_id returned by acp_new_session'),
        prompt: z
          .array(contentBlockSchema)
          .min(1)
          .describe('ACP PromptRequest.prompt — array of ContentBlocks'),
      },
      async (args, ctx) => this.handlePrompt(args, ctx),
    );

    agent.action(
      'acp_cancel',
      'Cancel the active background ACP prompt for a session_id. Sends a session/cancel notification to the peer. AgentLite still writes a terminal artifact and injects a completion notice with stop_reason "cancelled".',
      {
        session_id: z
          .string()
          .describe('The session_id of the in-flight prompt'),
      },
      async (args, ctx) => this.handleCancel(args, ctx),
    );

    agent.action(
      'acp_close_session',
      'End an ACP session and free host-side tracking. Call when done with a conversation. The peer child process stays alive for reuse by other sessions.',
      {
        session_id: z.string().describe('The session_id to close'),
      },
      async (args, ctx) => this.handleCloseSession(args, ctx),
    );
  }

  // ─── Action handlers ──────────────────────────────────────────────

  private async handleNewSession(
    args: { peer: string; cwd?: string },
    ctx: ActionContext,
  ): Promise<{ session_id: string }> {
    const peer = this.requirePeer(args.peer);
    await this.ensurePeerReady(peer);
    const callerChatJid = this.deps.resolveCallerChatJid(ctx);
    const cwd =
      args.cwd ?? resolveGroupFolderPath(ctx.sourceGroup, this.deps.groupsDir);
    // Peer may require the directory to exist on disk.
    fs.mkdirSync(cwd, { recursive: true });
    const resp = await peer.connection!.newSession({ cwd, mcpServers: [] });
    this.sessions.set(resp.sessionId, {
      peer: peer.config.name,
      callerGroupFolder: ctx.sourceGroup,
      callerChatJid,
      createdAt: Date.now(),
      accumulator: null,
      activeRunId: null,
    });
    ctx.log.info(
      {
        session_id: resp.sessionId,
        peer: peer.config.name,
        caller_chat_jid: callerChatJid,
      },
      'acp: new session',
    );
    return { session_id: resp.sessionId };
  }

  private async handlePrompt(
    args: {
      session_id: string;
      prompt: z.infer<typeof contentBlockSchema>[];
    },
    ctx: ActionContext,
  ): Promise<{ ok: true }> {
    const session = this.requireSession(args.session_id, ctx);
    const peer = this.requirePeer(session.peer);
    if (!peer.connection) {
      throw new Error(`peer ${peer.config.name} is not connected`);
    }
    if (session.activeRunId) {
      throw new Error(
        `acp session ${args.session_id} already has an in-flight prompt`,
      );
    }

    const acc: SessionAccumulator = { text: [], toolCalls: [] };
    const run = this.createPendingRun(session, args.session_id);
    await this.writeArtifact(run.hostPath, {
      session_id: run.sessionId,
      peer: run.peer,
      status: 'running',
      started_at: run.startedAt,
      text: '',
      tool_calls: [],
      text_bytes: 0,
      tool_call_count: 0,
    });

    this.pendingRuns.set(run.id, run);
    session.accumulator = acc;
    session.activeRunId = run.id;
    void this.runPromptInBackground(run, peer, args.prompt, acc);
    return { ok: true };
  }

  private async handleCancel(
    args: { session_id: string },
    ctx: ActionContext,
  ): Promise<{ ok: true }> {
    const session = this.requireSession(args.session_id, ctx);
    const peer = this.requirePeer(session.peer);
    if (session.activeRunId && peer.connection) {
      await peer.connection.cancel({ sessionId: args.session_id });
    }
    return { ok: true };
  }

  private async handleCloseSession(
    args: { session_id: string },
    ctx: ActionContext,
  ): Promise<{ ok: true }> {
    const session = this.requireSession(args.session_id, ctx);
    if (session.activeRunId) {
      throw new Error(
        `cannot close acp session ${args.session_id} while a prompt is in flight`,
      );
    }
    this.sessions.delete(args.session_id);
    // Zed ACP has no mandatory closeSession method; peer retains its own
    // session state until it decides to release it. We just drop our
    // local tracking so the session_id becomes invalid for our actions.
    return { ok: true };
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private requirePeer(name: string): PeerState {
    const peer = this.peers.get(name);
    if (!peer) {
      throw new Error(
        `unknown acp peer: ${name}. Call acp_list_remote_agents to see configured peers.`,
      );
    }
    return peer;
  }

  /**
   * Look up a session and verify the caller is allowed to act on it.
   * Main group can touch any session; non-main groups can only touch
   * sessions they created.
   */
  private requireSession(sessionId: string, ctx: ActionContext): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`unknown acp session: ${sessionId}`);
    }
    if (!ctx.isMain && session.callerGroupFolder !== ctx.sourceGroup) {
      throw new Error(`acp session ${sessionId} is owned by a different group`);
    }
    return session;
  }

  private findCallerForSession(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.callerGroupFolder ?? null;
  }

  private createPendingRun(
    session: SessionState,
    sessionId: string,
  ): PendingRun {
    const runId = `acp-run-${randomUUID()}`;
    const groupIpcDir = resolveGroupIpcPath(
      session.callerGroupFolder,
      this.deps.dataDir,
    );
    const runsDir = path.join(groupIpcDir, 'acp', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    return {
      id: runId,
      sessionId,
      peer: session.peer,
      callerGroupFolder: session.callerGroupFolder,
      callerChatJid: session.callerChatJid,
      startedAt: new Date().toISOString(),
      hostPath: path.join(runsDir, `${runId}.json`),
      containerPath: path.posix.join(
        '/workspace/ipc',
        'acp',
        'runs',
        `${runId}.json`,
      ),
    };
  }

  private async runPromptInBackground(
    run: PendingRun,
    peer: PeerState,
    prompt: z.infer<typeof contentBlockSchema>[],
    acc: SessionAccumulator,
  ): Promise<void> {
    let status: RunStatus = 'failed';
    let stopReason = 'failed';
    let error: string | undefined;

    try {
      if (!peer.connection) {
        throw new Error(`peer ${peer.config.name} is not connected`);
      }
      const response = await peer.connection.prompt({
        sessionId: run.sessionId,
        prompt,
      });
      stopReason = response.stopReason;
      status = response.stopReason === 'cancelled' ? 'cancelled' : 'completed';
    } catch (err) {
      error = errMsg(err);
      logger.warn(
        { session_id: run.sessionId, peer: run.peer, err: error },
        'acp: background prompt failed',
      );
    }

    const text = acc.text.join('');
    const toolCalls = [...acc.toolCalls];
    const artifact: AcpRunArtifact = {
      session_id: run.sessionId,
      peer: run.peer,
      status,
      stop_reason: stopReason,
      started_at: run.startedAt,
      completed_at: new Date().toISOString(),
      text,
      tool_calls: toolCalls,
      text_bytes: Buffer.byteLength(text, 'utf-8'),
      tool_call_count: toolCalls.length,
      ...(error ? { error } : {}),
    };

    const session = this.sessions.get(run.sessionId);
    if (session?.activeRunId === run.id) {
      session.activeRunId = null;
      session.accumulator = null;
    }
    this.pendingRuns.delete(run.id);

    try {
      await this.writeArtifact(run.hostPath, artifact);
    } catch (err) {
      logger.error(
        { session_id: run.sessionId, path: run.hostPath, err },
        'acp: failed to write result artifact',
      );
      return;
    }

    const notice = this.formatCompletionNotice(run, artifact);
    try {
      await this.deps.injectNotice(run.callerChatJid, notice);
    } catch (err) {
      logger.error(
        { session_id: run.sessionId, chat_jid: run.callerChatJid, err },
        'acp: failed to inject completion notice',
      );
    }
  }

  private formatCompletionNotice(
    run: PendingRun,
    artifact: AcpRunArtifact,
  ): string {
    if (artifact.status === 'failed') {
      return `ACP prompt finished for session ${run.sessionId}: failed. Result file: ${run.containerPath}`;
    }
    return `ACP prompt finished for session ${run.sessionId}: ${artifact.status} (${artifact.stop_reason}). Result file: ${run.containerPath}`;
  }

  private async writeArtifact(
    filePath: string,
    artifact: AcpRunArtifact,
  ): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(
      filePath,
      JSON.stringify(artifact, null, 2),
      'utf-8',
    );
  }

  private recoverAbandonedArtifacts(): void {
    const recoveredAt = new Date().toISOString();
    for (const filePath of this.listArtifactPaths()) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const artifact = JSON.parse(raw) as Partial<AcpRunArtifact>;
        if (artifact.status !== 'running') continue;
        const recovered: AcpRunArtifact = {
          session_id: artifact.session_id ?? 'unknown',
          peer: artifact.peer ?? 'unknown',
          status: 'failed',
          stop_reason: 'abandoned',
          started_at: artifact.started_at ?? recoveredAt,
          completed_at: recoveredAt,
          text: artifact.text ?? '',
          tool_calls: artifact.tool_calls ?? [],
          text_bytes:
            typeof artifact.text_bytes === 'number'
              ? artifact.text_bytes
              : Buffer.byteLength(artifact.text ?? '', 'utf-8'),
          tool_call_count:
            typeof artifact.tool_call_count === 'number'
              ? artifact.tool_call_count
              : (artifact.tool_calls ?? []).length,
          error: artifact.error ?? 'Host restarted before ACP prompt completed',
        };
        fs.writeFileSync(filePath, JSON.stringify(recovered, null, 2), 'utf-8');
      } catch (err) {
        logger.warn(
          { filePath, err },
          'acp: failed to recover abandoned artifact',
        );
      }
    }
  }

  private sweepExpiredArtifacts(): void {
    const cutoff = Date.now() - ACP_RUN_RETENTION_MS;
    for (const filePath of this.listArtifactPaths()) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        logger.warn({ filePath, err }, 'acp: failed to sweep old artifact');
      }
    }
  }

  private listArtifactPaths(): string[] {
    const ipcBaseDir = path.join(this.deps.dataDir, 'ipc');
    if (!fs.existsSync(ipcBaseDir)) return [];

    const out: string[] = [];
    for (const entry of fs.readdirSync(ipcBaseDir)) {
      const runsDir = path.join(ipcBaseDir, entry, 'acp', 'runs');
      if (!fs.existsSync(runsDir)) continue;
      for (const file of fs.readdirSync(runsDir)) {
        if (file.endsWith('.json')) {
          out.push(path.join(runsDir, file));
        }
      }
    }
    return out;
  }

  // ─── Peer lifecycle (lazy spawn + crash recovery) ─────────────────

  /** Ensure the peer's child process is spawned and `initialize` completed. */
  private async ensurePeerReady(peer: PeerState): Promise<void> {
    if (peer.connection && peer.child && !peer.child.killed) return;
    if (peer.spawnPromise) return peer.spawnPromise;

    peer.spawnPromise = this.spawnPeer(peer).finally(() => {
      peer.spawnPromise = null;
    });
    return peer.spawnPromise;
  }

  private async spawnPeer(peer: PeerState): Promise<void> {
    const child = spawn(peer.config.command, peer.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(peer.config.env ?? {}),
      },
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      logger.debug(
        { peer: peer.config.name, stderr: chunk.toString() },
        'acp: peer stderr',
      );
    });
    child.on('exit', (code, signal) => {
      logger.warn(
        { peer: peer.config.name, code, signal },
        'acp: peer child exited',
      );
      this.onPeerCrashed(peer, `exit code=${code} signal=${signal}`);
    });
    child.on('error', (err) => {
      logger.error({ peer: peer.config.name, err }, 'acp: peer spawn error');
      this.onPeerCrashed(peer, errMsg(err));
    });

    const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise((resolve, reject) => {
          child.stdin!.write(chunk, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
    });
    const stream = ndJsonStream(output, input);

    const conn = new ClientSideConnection(
      () => this.buildClientHandler(peer),
      stream,
    );

    peer.child = child;
    peer.connection = conn;

    try {
      const init = await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      });
      peer.agentInfo = init.agentInfo
        ? {
            name: init.agentInfo.name,
            version: init.agentInfo.version,
            title: init.agentInfo.title,
          }
        : null;
      logger.info(
        { peer: peer.config.name, agentInfo: peer.agentInfo },
        'acp: peer initialized',
      );
    } catch (err) {
      logger.error(
        { peer: peer.config.name, err },
        'acp: peer initialize failed',
      );
      child.kill();
      this.onPeerCrashed(peer, `initialize failed: ${errMsg(err)}`);
      throw err;
    }
  }

  /** Evict all in-memory state for a peer. In-flight prompts reject naturally. */
  private onPeerCrashed(peer: PeerState, reason: string): void {
    peer.child = null;
    peer.connection = null;
    peer.agentInfo = null;
    peer.spawnPromise = null;
    // Drop sessions owned by this peer. In-flight prompts' accumulators
    // become orphaned; their awaited `prompt()` call will reject when the
    // stream closes, surfacing the failure to the action caller.
    for (const [sessionId, session] of this.sessions) {
      if (session.peer === peer.config.name) {
        this.sessions.delete(sessionId);
      }
    }
    logger.warn(
      { peer: peer.config.name, reason },
      'acp: peer crashed, sessions evicted',
    );
  }

  // ─── Client-side callbacks (peer → us) ────────────────────────────

  /** Build the Client-side callback handler the peer invokes. */
  private buildClientHandler(_peer: PeerState): Client {
    return {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const session = this.sessions.get(params.sessionId);
        if (!session?.accumulator) return;
        const update = params.update;
        if (update.sessionUpdate === 'agent_message_chunk') {
          const content = update.content;
          if (content.type === 'text') {
            session.accumulator.text.push(content.text);
          }
        } else if (update.sessionUpdate === 'tool_call_update') {
          session.accumulator.toolCalls.push(update);
        }
      },
      requestPermission: async (
        _params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        // v1: auto-deny all tool permission requests. A future policy
        // allowlist would plug in here.
        return { outcome: { outcome: 'cancelled' } };
      },
      readTextFile: async (
        params: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> => {
        const callerFolder = this.findCallerForSession(params.sessionId);
        if (!callerFolder) {
          throw new Error('unknown acp session');
        }
        const sandboxRoot = path.resolve(
          resolveGroupFolderPath(callerFolder, this.deps.groupsDir),
        );
        const resolved = path.resolve(params.path);
        if (
          resolved !== sandboxRoot &&
          !resolved.startsWith(sandboxRoot + path.sep)
        ) {
          throw new Error(`path outside sandbox: ${params.path}`);
        }
        let content = await fs.promises.readFile(resolved, 'utf-8');
        if (params.line != null || params.limit != null) {
          const lines = content.split('\n');
          const start = Math.max(0, (params.line ?? 1) - 1);
          const end =
            params.limit != null ? start + params.limit : lines.length;
          content = lines.slice(start, end).join('\n');
        }
        return { content };
      },
      writeTextFile: async (
        params: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> => {
        const callerFolder = this.findCallerForSession(params.sessionId);
        if (!callerFolder) throw new Error('unknown acp session');
        const sandboxRoot = path.resolve(
          resolveGroupFolderPath(callerFolder, this.deps.groupsDir),
        );
        const resolved = path.resolve(params.path);
        if (
          resolved !== sandboxRoot &&
          !resolved.startsWith(sandboxRoot + path.sep)
        ) {
          throw new Error(`path outside sandbox: ${params.path}`);
        }
        await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
        await fs.promises.writeFile(resolved, params.content, 'utf-8');
        return {};
      },
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /** Graceful shutdown: kill all peer children, clear session tracking. */
  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.sessions.clear();
    for (const peer of this.peers.values()) {
      if (peer.child && !peer.child.killed) {
        peer.child.kill();
      }
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
