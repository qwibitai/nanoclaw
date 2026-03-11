/**
 * DayZero Channel for NanoClaw
 * =============================================================================
 * Exposes an HTTP API to trigger DayZero assessment runs.
 * Accepts POST /v1/run with a company name and engagement mode,
 * routes the prompt to the dayzero agent group, and collects responses.
 *
 * Responses are accumulated per-run and retrievable via GET /v1/runs/:id.
 */

import crypto from 'crypto';
import http from 'http';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

// --- Constants ---

const DEFAULT_PORT = 9002;
const DAYZERO_JID = 'internal:dayzero';

// --- Interfaces ---

interface RunRecord {
  id: string;
  company: string;
  engagementMode: string;
  status: 'running' | 'completed' | 'error';
  startedAt: string;
  messages: Array<{ text: string; timestamp: string }>;
  // Geodesic workflow integration
  workflowRunId?: string;
  tenantId?: string;
  workspaceId?: string;
}

interface DayZeroChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// --- Channel Implementation ---

export class DayZeroChannel implements Channel {
  name = 'dayzero';

  private server: http.Server | null = null;
  private connected = false;
  private port: number;
  private opts: DayZeroChannelOpts;

  // Track active and completed runs
  private runs = new Map<string, RunRecord>();

  constructor(opts: DayZeroChannelOpts) {
    this.opts = opts;

    const envConfig = readEnvFile(['DAYZERO_PORT']);
    this.port = parseInt(
      process.env.DAYZERO_PORT || envConfig.DAYZERO_PORT || String(DEFAULT_PORT),
      10,
    );
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) =>
        this.handleRequest(req, res),
      );

      this.server.on('error', (err) => {
        if (!this.connected) {
          reject(err);
        } else {
          logger.error({ err }, 'DayZero HTTP server error');
        }
      });

      this.server.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, 'DayZero API listening');
        resolve();
      });
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    // Find the run that this message belongs to by matching the JID
    // All DayZero messages go through the single internal:dayzero JID,
    // so we append to the most recent running run
    for (const [, run] of this.runs) {
      if (run.status === 'running') {
        run.messages.push({
          text,
          timestamp: new Date().toISOString(),
        });
        logger.info(
          { runId: run.id.slice(0, 8), length: text.length },
          'DayZero agent response captured',
        );
        return;
      }
    }

    logger.warn('DayZero agent response received but no active run');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid === DAYZERO_JID;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op
  }

  // --- HTTP Request Handler ---

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '';
    const method = req.method || '';

    if (method === 'GET' && url === '/health') {
      this.handleHealth(res);
      return;
    }

    if (method === 'POST' && url === '/v1/run') {
      this.readBody(req)
        .then((body) => this.handleRun(body, res))
        .catch((err) => {
          logger.error({ err }, 'Error handling DayZero run');
          this.sendJson(res, 500, { error: 'Internal server error' });
        });
      return;
    }

    // GET /v1/runs/:id
    const runMatch = url.match(/^\/v1\/runs\/([a-f0-9-]+)$/);
    if (method === 'GET' && runMatch) {
      this.handleGetRun(runMatch[1], res);
      return;
    }

    // POST /v1/runs/:id/complete — mark a run as completed
    const completeMatch = url.match(/^\/v1\/runs\/([a-f0-9-]+)\/complete$/);
    if (method === 'POST' && completeMatch) {
      this.handleCompleteRun(completeMatch[1], res);
      return;
    }

    if (method === 'GET' && url === '/v1/runs') {
      this.handleListRuns(res);
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  private handleHealth(res: http.ServerResponse): void {
    const activeRuns = [...this.runs.values()]
      .filter((r) => r.status === 'running')
      .map((r) => ({ id: r.id.slice(0, 8), company: r.company }));

    this.sendJson(res, 200, {
      status: 'ok',
      active_runs: activeRuns.length,
      runs: activeRuns,
    });
  }

  private async handleRun(
    body: Record<string, unknown>,
    res: http.ServerResponse,
  ): Promise<void> {
    const company = String(body.company || '');
    const engagementMode = String(
      body.engagement_mode || body.engagementMode || 'turnaround_diagnostic',
    );
    const phase = body.phase ? String(body.phase) : undefined;

    // Geodesic workflow integration fields
    const workflowRunId = body.workflow_run_id ? String(body.workflow_run_id) : undefined;
    const tenantId = body.tenant_id ? String(body.tenant_id) : undefined;
    const workspaceId = body.workspace_id ? String(body.workspace_id) : undefined;

    if (!company) {
      this.sendJson(res, 400, {
        error: 'Missing required field: company',
      });
      return;
    }

    const runId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    logger.info(
      { runId: runId.slice(0, 8), company, engagementMode, workflowRunId, tenantId, workspaceId },
      'DayZero run requested',
    );

    // Create run record
    const run: RunRecord = {
      id: runId,
      company,
      engagementMode,
      status: 'running',
      startedAt: timestamp,
      messages: [],
      workflowRunId,
      tenantId,
      workspaceId,
    };
    this.runs.set(runId, run);

    // Build prompt for the agent
    const promptLines = [
      `Run a DayZero ${engagementMode} assessment on company: ${company}`,
      '',
      `Run ID: ${runId}`,
      `Data package: /workspace/extra/dayzero/data/${company}/`,
      `Output directory: /workspace/extra/dayzero/runs/${company}_${runId.slice(0, 8)}/`,
    ];

    if (phase) {
      promptLines.push('', `Resume from phase: ${phase}`);
    }

    // Include Geodesic workflow context if provided
    if (workflowRunId) {
      promptLines.push('', '--- Geodesic Workflow Integration ---');
      promptLines.push(`Workflow Run ID: ${workflowRunId}`);
      if (tenantId) {
        promptLines.push(`Tenant ID: ${tenantId}`);
      }
      if (workspaceId) {
        promptLines.push(`Workspace ID: ${workspaceId}`);
      }
      promptLines.push('', 'Update workflow progress via GraphQL mutation:');
      promptLines.push('updateWorkflowRun(workflowRunId, status, progress, currentPhase, currentTask)');
    }

    // Report metadata for group discovery
    this.opts.onChatMetadata(DAYZERO_JID, timestamp, 'DayZero', 'dayzero', true);

    // Inject message into NanoClaw message flow
    this.opts.onMessage(DAYZERO_JID, {
      id: runId,
      chat_jid: DAYZERO_JID,
      sender: 'dayzero-api',
      sender_name: 'DayZero API',
      content: promptLines.join('\n'),
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });

    this.sendJson(res, 200, {
      status: 'started',
      run_id: runId,
      company,
      engagement_mode: engagementMode,
      poll_url: `/v1/runs/${runId}`,
    });
  }

  private handleGetRun(runId: string, res: http.ServerResponse): void {
    const run = this.runs.get(runId);
    if (!run) {
      this.sendJson(res, 404, { error: 'Run not found' });
      return;
    }

    const response: Record<string, unknown> = {
      id: run.id,
      company: run.company,
      engagement_mode: run.engagementMode,
      status: run.status,
      started_at: run.startedAt,
      message_count: run.messages.length,
      messages: run.messages,
    };

    // Include workflow context if available
    if (run.workflowRunId) {
      response.workflow_run_id = run.workflowRunId;
    }
    if (run.tenantId) {
      response.tenant_id = run.tenantId;
    }
    if (run.workspaceId) {
      response.workspace_id = run.workspaceId;
    }

    this.sendJson(res, 200, response);
  }

  private handleCompleteRun(runId: string, res: http.ServerResponse): void {
    const run = this.runs.get(runId);
    if (!run) {
      this.sendJson(res, 404, { error: 'Run not found' });
      return;
    }

    run.status = 'completed';
    logger.info({ runId: runId.slice(0, 8) }, 'DayZero run marked complete');
    this.sendJson(res, 200, { status: 'completed', run_id: runId });
  }

  private handleListRuns(res: http.ServerResponse): void {
    const runs = [...this.runs.values()].map((r) => ({
      id: r.id,
      company: r.company,
      engagement_mode: r.engagementMode,
      status: r.status,
      started_at: r.startedAt,
      message_count: r.messages.length,
    }));

    this.sendJson(res, 200, { runs });
  }

  // --- Helpers ---

  private readBody(
    req: http.IncomingMessage,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          resolve(body);
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    data: unknown,
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

// --- Channel Registration ---

registerChannel('dayzero', (opts: ChannelOpts) => {
  return new DayZeroChannel(opts);
});
