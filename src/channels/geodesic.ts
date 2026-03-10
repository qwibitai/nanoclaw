/**
 * Geodesic Channel for NanoClaw
 * =============================================================================
 * Receives ScenarioRun events from the Geodesic workspace chat UI,
 * routes prompts to the NanoClaw agent, and posts agent responses back
 * to Geodesic via the appendScenarioRunLog GraphQL mutation.
 *
 * Phase 1: Single copilot group (geodesic-copilot), text responses only.
 * Phase 2: Builder agent for HTML reports, dynamic group per workspace.
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

// --- Constants ---

const DEFAULT_PORT = 9001;
const TOKEN_REFRESH_MS = 45 * 60 * 1000; // 45 minutes
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const SSE_RECONNECT_MS = 5000;
const INTENT_CLASSIFY_TIMEOUT_MS = 8000;
const COPILOT_GROUP_FOLDER = 'geodesic-copilot';

// --- Interfaces ---

interface GeodesicCreds {
  GRAPHQL_AUTH_TENANT_ID: string;
  GRAPHQL_AUTH_CLIENT_ID: string;
  GRAPHQL_AUTH_CLIENT_SECRET: string;
  GRAPHQL_AUTH_SCOPE: string;
}

interface ActiveConversation {
  runId: string;
  workspaceId: string;
  tenantId: string;
  lastActivity: number;
  abortController: AbortController;
}

interface GeodesicChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// --- Channel Implementation ---

export class GeodesicChannel implements Channel {
  name = 'geodesic';

  private server: http.Server | null = null;
  private connected = false;
  private port: number;
  private endpoint: string;
  private dataTenant: string;
  private creds: GeodesicCreds;
  private opts: GeodesicChannelOpts;

  // OAuth token cache
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  // Workspace → active conversation tracking
  private activeConversations = new Map<string, ActiveConversation>();

  // Anthropic API key for intent classification
  private anthropicApiKey: string | undefined;

  constructor(opts: GeodesicChannelOpts, creds: GeodesicCreds) {
    this.opts = opts;
    this.creds = creds;

    const envConfig = readEnvFile([
      'GEODESIC_RELAY_PORT',
      'GEODESIC_ENDPOINT',
      'GEODESIC_DATA_TENANT',
      'ANTHROPIC_API_KEY',
    ]);

    this.port = parseInt(
      process.env.GEODESIC_RELAY_PORT ||
        envConfig.GEODESIC_RELAY_PORT ||
        String(DEFAULT_PORT),
      10,
    );
    this.endpoint =
      process.env.GEODESIC_ENDPOINT ||
      envConfig.GEODESIC_ENDPOINT ||
      'https://app-sbx-westus3-01.azurewebsites.net/gql';
    this.dataTenant =
      process.env.GEODESIC_DATA_TENANT ||
      envConfig.GEODESIC_DATA_TENANT ||
      'e7d347f1-ea8c-4933-9807-29f19a9237e7';
    this.anthropicApiKey =
      process.env.ANTHROPIC_API_KEY || envConfig.ANTHROPIC_API_KEY;
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
          logger.error({ err }, 'Geodesic HTTP server error');
        }
      });

      this.server.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, 'Geodesic relay listening');
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const workspaceId = jid.replace(/^geodesic:/, '');
    const conv = this.activeConversations.get(workspaceId);

    if (!conv) {
      logger.warn(
        { jid },
        'No active Geodesic conversation for workspace, dropping message',
      );
      return;
    }

    conv.lastActivity = Date.now();

    try {
      const token = await this.getToken();
      await this.postGeodesicEvent(conv.runId, 'agent_message', text, token);
      logger.info(
        { jid, runId: conv.runId.slice(0, 8), length: text.length },
        'Geodesic message sent',
      );
    } catch (err) {
      logger.error(
        { jid, err },
        'Failed to post agent message to Geodesic',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('geodesic:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    // Cancel all SSE watchers
    for (const [, conv] of this.activeConversations) {
      conv.abortController.abort();
    }
    this.activeConversations.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Geodesic has no typing indicator
  }

  // --- HTTP Request Handler ---

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '';
    const method = req.method || '';

    if (method === 'GET' && url === '/health') {
      this.handleHealth(res);
      return;
    }

    if (method === 'POST' && url === '/v1/start_run') {
      this.readBody(req)
        .then((body) => this.handleStartRun(body, res))
        .catch((err) => {
          logger.error({ err }, 'Error handling start_run');
          this.sendJson(res, 500, { error: 'Internal server error' });
        });
      return;
    }

    if (method === 'POST' && url === '/v1/report_ready') {
      this.readBody(req)
        .then((body) => this.handleReportReady(body, res))
        .catch((err) => {
          logger.error({ err }, 'Error handling report_ready');
          this.sendJson(res, 500, { error: 'Internal server error' });
        });
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  private handleHealth(res: http.ServerResponse): void {
    const workspaces = [...this.activeConversations.keys()].map(
      (ws) => ws.slice(0, 8) + '...',
    );
    this.sendJson(res, 200, {
      status: 'ok',
      active_conversations: this.activeConversations.size,
      workspaces,
    });
  }

  private async handleStartRun(
    body: Record<string, unknown>,
    res: http.ServerResponse,
  ): Promise<void> {
    const runId = String(body.runId || body.run_id || '');
    const workspaceId = String(body.workspaceId || body.workspace_id || '');
    const tenantId = String(body.tenantId || body.tenant_id || '');
    const userPrompt = String(body.prompt || body.inputs || '(empty)');

    if (!runId || !workspaceId || !tenantId) {
      this.sendJson(res, 400, {
        error: 'Missing required fields: runId, workspaceId, tenantId',
      });
      return;
    }

    logger.info(
      { runId: runId.slice(0, 8), workspaceId: workspaceId.slice(0, 8) },
      'Geodesic start_run received',
    );

    // Cancel existing watcher for this workspace
    const existing = this.activeConversations.get(workspaceId);
    if (existing) {
      existing.abortController.abort();
      this.activeConversations.delete(workspaceId);
    }

    // Post workflow_started to Geodesic
    try {
      const token = await this.getToken();
      await this.postGeodesicEvent(runId, 'workflow_started', '', token, {
        workspace_id: workspaceId,
        run_id: runId,
      });
      logger.info(
        { runId: runId.slice(0, 8) },
        'workflow_started posted to Geodesic',
      );
    } catch (err) {
      logger.warn(
        { runId: runId.slice(0, 8), err },
        'Could not post workflow_started',
      );
    }

    // Classify intent
    const isReportRequest = await this.classifyIntent(userPrompt);

    // Build message for NanoClaw agent
    const jid = `geodesic:${workspaceId}`;
    let agentMessage: string;

    if (isReportRequest) {
      const dataFile = `/tmp/geodesic-report-${runId.slice(0, 8)}.json`;
      agentMessage = [
        `geodesic-copilot run_id=${runId} workspace_id=${workspaceId}`,
        '',
        '[REPORT_REQUEST]',
        `question=${userPrompt}`,
        `data_file=${dataFile}`,
        '',
        `The user wants a visual report. Your job is DATA COLLECTION ONLY:`,
        `1. Query the graph for: ${userPrompt}`,
        `2. Structure your findings as JSON`,
        `3. Write the JSON to: ${dataFile}`,
        `4. Post exactly this as your agent_message: REPORT_DATA_READY`,
        '',
        'Do NOT generate HTML. Do NOT post analysis text. Just JSON + REPORT_DATA_READY.',
      ].join('\n');
    } else {
      agentMessage = [
        `geodesic-copilot run_id=${runId} workspace_id=${workspaceId}`,
        '',
        userPrompt,
      ].join('\n');
    }

    // Report metadata for group discovery
    const timestamp = new Date().toISOString();
    this.opts.onChatMetadata(jid, timestamp, `Geodesic ${workspaceId.slice(0, 8)}`, 'geodesic', true);

    // Inject message into NanoClaw message flow
    this.opts.onMessage(jid, {
      id: runId,
      chat_jid: jid,
      sender: 'geodesic-user',
      sender_name: 'Geodesic User',
      content: agentMessage,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });

    // Track active conversation
    const abortController = new AbortController();
    this.activeConversations.set(workspaceId, {
      runId,
      workspaceId,
      tenantId,
      lastActivity: Date.now(),
      abortController,
    });

    // Spawn SSE watcher for follow-up messages
    this.watchConversation(runId, workspaceId, tenantId, abortController);

    this.sendJson(res, 200, { status: 'hook_delivered', run_id: runId });
  }

  private async handleReportReady(
    body: Record<string, unknown>,
    res: http.ServerResponse,
  ): Promise<void> {
    const runId = String(body.run_id || '');
    const workspaceId = String(body.workspace_id || '');

    logger.info(
      { runId: runId.slice(0, 8) },
      '/v1/report_ready received (Phase 2 — deferred)',
    );

    this.sendJson(res, 200, { ok: true, run_id: runId, note: 'Builder dispatch deferred to Phase 2' });
  }

  // --- Intent Classification ---

  private async classifyIntent(text: string): Promise<boolean> {
    if (!this.anthropicApiKey) return false;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        INTENT_CLASSIFY_TIMEOUT_MS,
      );

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 5,
          system:
            "You classify user intent. Reply with ONLY 'YES' if the user is asking for a visual report, dashboard, chart, graph, or data visualization. Reply with ONLY 'NO' for all other requests.",
          messages: [{ role: 'user', content: text }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        logger.warn(
          { status: resp.status },
          'Intent classification API error',
        );
        return false;
      }

      const data = (await resp.json()) as {
        content: Array<{ text: string }>;
      };
      const answer = data.content[0].text.trim().toUpperCase();
      logger.info(
        { answer, prompt: text.slice(0, 80) },
        'Intent classified',
      );
      return answer.startsWith('YES');
    } catch (err) {
      logger.warn({ err }, 'Intent classification failed, defaulting to NO');
      return false;
    }
  }

  // --- SSE Conversation Watcher ---

  private watchConversation(
    runId: string,
    workspaceId: string,
    tenantId: string,
    abortController: AbortController,
  ): void {
    // Run asynchronously — don't block the request handler
    this.runSSEWatcher(runId, workspaceId, tenantId, abortController).catch(
      (err) => {
        if (err?.name !== 'AbortError') {
          logger.error(
            { runId: runId.slice(0, 8), err },
            'SSE watcher crashed',
          );
        }
      },
    );
  }

  private async runSSEWatcher(
    runId: string,
    workspaceId: string,
    tenantId: string,
    abortController: AbortController,
  ): Promise<void> {
    const baseUrl = this.endpoint
      .replace('/gql/', '')
      .replace('/gql', '')
      .replace(/\/$/, '');
    const sseUrl = `${baseUrl}/runs/${runId}/events?tid=${tenantId}`;

    let token = await this.getToken();
    let tokenRefreshedAt = Date.now();
    let seenWorkflowStarted = false;
    let seenInitialUserMessage = false;
    const processedIds = new Set<string>();
    const jid = `geodesic:${workspaceId}`;

    logger.info({ runId: runId.slice(0, 8) }, 'SSE watcher started');

    // Small delay to let the initial event propagate
    await this.sleep(2000, abortController.signal);

    while (!abortController.signal.aborted) {
      // Refresh token periodically
      if (Date.now() - tokenRefreshedAt > TOKEN_REFRESH_MS) {
        token = await this.getToken();
        tokenRefreshedAt = Date.now();
      }

      // Check idle timeout
      const conv = this.activeConversations.get(workspaceId);
      if (!conv || Date.now() - conv.lastActivity > IDLE_TIMEOUT_MS) {
        logger.info(
          { runId: runId.slice(0, 8) },
          'Idle timeout — posting workflow_completed',
        );
        try {
          const tok = await this.getToken();
          await this.postGeodesicEvent(runId, 'workflow_completed', '', tok);
        } catch (err) {
          logger.warn(
            { runId: runId.slice(0, 8), err },
            'Could not post workflow_completed',
          );
        }
        this.activeConversations.delete(workspaceId);
        return;
      }

      try {
        const resp = await fetch(sseUrl, {
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
            'X-Tenant-Id': tenantId,
          },
          signal: abortController.signal,
        });

        if (!resp.ok) {
          logger.warn(
            { runId: runId.slice(0, 8), status: resp.status },
            'SSE connection failed',
          );
          await this.sleep(SSE_RECONNECT_MS, abortController.signal);
          continue;
        }

        if (!resp.body) {
          await this.sleep(SSE_RECONNECT_MS, abortController.signal);
          continue;
        }

        logger.info({ runId: runId.slice(0, 8) }, 'SSE connected');

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!abortController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          // Check idle timeout during streaming
          const convCheck = this.activeConversations.get(workspaceId);
          if (
            !convCheck ||
            Date.now() - convCheck.lastActivity > IDLE_TIMEOUT_MS
          ) {
            reader.cancel();
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          while (buffer.includes('\n\n')) {
            const [block, rest] = buffer.split('\n\n', 2);
            buffer = rest;

            let eventId: string | null = null;
            let data: string | null = null;

            for (const line of block.split('\n')) {
              const trimmed = line.trim();
              if (trimmed.startsWith('id: ')) {
                eventId = trimmed.slice(4).trim();
              } else if (trimmed.startsWith('data: ')) {
                data = trimmed.slice(6).trim();
              }
            }

            if (!data || (eventId && processedIds.has(eventId))) continue;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }

            const eventType = event.event_type as string;

            if (eventType === 'workflow_started') {
              seenWorkflowStarted = true;
              if (conv) conv.lastActivity = Date.now();
              if (eventId) processedIds.add(eventId);
              continue;
            }

            if (eventType === 'workflow_completed') {
              if (conv) conv.lastActivity = Date.now();
              // Stay open — don't close on workflow_completed from Geodesic
              continue;
            }

            if (
              eventType === 'user_message' &&
              seenWorkflowStarted
            ) {
              const userMsg = String(event.message || '').trim();
              if (!userMsg || (eventId && processedIds.has(eventId))) continue;
              if (eventId) processedIds.add(eventId);

              if (conv) conv.lastActivity = Date.now();

              // Skip the first user_message — it's an SSE echo of the start_run prompt
              if (!seenInitialUserMessage) {
                seenInitialUserMessage = true;
                logger.info(
                  { runId: runId.slice(0, 8) },
                  'Skipping SSE echo of initial prompt',
                );
                continue;
              }

              logger.info(
                {
                  runId: runId.slice(0, 8),
                  msg: userMsg.slice(0, 80),
                },
                'Follow-up user_message from Geodesic',
              );

              // Classify follow-up intent
              const isReport = await this.classifyIntent(userMsg);
              let followUpContent: string;

              if (isReport) {
                const dataFile = `/tmp/geodesic-report-${runId.slice(0, 8)}.json`;
                followUpContent = [
                  `geodesic-copilot run_id=${runId} workspace_id=${workspaceId}`,
                  '',
                  '[REPORT_REQUEST]',
                  `question=${userMsg}`,
                  `data_file=${dataFile}`,
                  '',
                  `The user wants a visual report. Your job is DATA COLLECTION ONLY:`,
                  `1. Query the graph for: ${userMsg}`,
                  `2. Structure your findings as JSON`,
                  `3. Write the JSON to: ${dataFile}`,
                  `4. Post exactly this as your agent_message: REPORT_DATA_READY`,
                  '',
                  'Do NOT generate HTML. Do NOT post analysis text. Just JSON + REPORT_DATA_READY.',
                ].join('\n');
              } else {
                followUpContent = [
                  `geodesic-copilot run_id=${runId} workspace_id=${workspaceId}`,
                  '',
                  userMsg,
                ].join('\n');
              }

              const timestamp = new Date().toISOString();
              this.opts.onMessage(jid, {
                id: `${runId}-followup-${Date.now()}`,
                chat_jid: jid,
                sender: 'geodesic-user',
                sender_name: 'Geodesic User',
                content: followUpContent,
                timestamp,
                is_from_me: false,
                is_bot_message: false,
              });
            }
          }
        }
      } catch (err: unknown) {
        if (
          abortController.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return;
        }
        logger.warn(
          { runId: runId.slice(0, 8), err },
          'SSE error, reconnecting',
        );
        await this.sleep(SSE_RECONNECT_MS, abortController.signal);
      }
    }
  }

  // --- OAuth Token ---

  async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const tid = this.creds.GRAPHQL_AUTH_TENANT_ID;
    const tokenUrl = `https://${tid}.ciamlogin.com/${tid}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.creds.GRAPHQL_AUTH_CLIENT_ID,
      client_secret: this.creds.GRAPHQL_AUTH_CLIENT_SECRET,
      scope: this.creds.GRAPHQL_AUTH_SCOPE + '/.default',
    });

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!resp.ok) {
      throw new Error(`OAuth token request failed: ${resp.status}`);
    }

    const data = (await resp.json()) as { access_token: string; expires_in?: number };
    this.cachedToken = data.access_token;
    // Refresh 5 minutes before expiry, or use TOKEN_REFRESH_MS
    const expiresIn = (data.expires_in || 3600) * 1000;
    this.tokenExpiresAt = Date.now() + Math.min(expiresIn - 300_000, TOKEN_REFRESH_MS);
    return this.cachedToken;
  }

  // --- Geodesic GraphQL Events ---

  private async postGeodesicEvent(
    runId: string,
    eventType: string,
    message: string,
    token: string,
    extra?: Record<string, string>,
  ): Promise<void> {
    const ts = new Date().toISOString();
    const event: Record<string, unknown> = {
      event_type: eventType,
      agent_id: ASSISTANT_NAME.toLowerCase(),
      stage: 'chat',
      timestamp: ts,
    };

    if (eventType === 'workflow_started') {
      event.message = `${ASSISTANT_NAME} Copilot started`;
      if (extra) Object.assign(event, extra);
    } else if (eventType === 'agent_message') {
      event.message = message;
      event.message_id = `${runId}-${Date.now()}`;
      event.completed = true;
      event.buffered = true;
    } else if (eventType === 'workflow_completed') {
      event.message = `${ASSISTANT_NAME} Copilot session ended`;
    } else {
      event.message = message;
    }

    const mutation = `mutation AppendLog($runId: UUID!, $content: String!) {
      appendScenarioRunLog(runId: $runId, content: $content)
    }`;

    const resp = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Tenant-Id': this.dataTenant,
      },
      body: JSON.stringify({
        query: mutation,
        variables: { runId, content: JSON.stringify(event) },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GraphQL request failed: ${resp.status} ${text}`);
    }
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
        } catch (err) {
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

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

// --- Credential Loading ---

function loadGeodesicCreds(): GeodesicCreds | null {
  const credsPath = path.join(
    process.env.HOME || os.homedir(),
    '.geodesic-creds.env',
  );

  if (!fs.existsSync(credsPath)) return null;

  const content = fs.readFileSync(credsPath, 'utf-8');
  const creds: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (value) creds[key] = value;
  }

  const required = [
    'GRAPHQL_AUTH_TENANT_ID',
    'GRAPHQL_AUTH_CLIENT_ID',
    'GRAPHQL_AUTH_CLIENT_SECRET',
    'GRAPHQL_AUTH_SCOPE',
  ];

  for (const key of required) {
    if (!creds[key]) {
      logger.warn(
        { key, credsPath },
        'Missing required Geodesic credential',
      );
      return null;
    }
  }

  return creds as unknown as GeodesicCreds;
}

// --- Channel Registration ---

registerChannel('geodesic', (opts: ChannelOpts) => {
  const creds = loadGeodesicCreds();
  if (!creds) {
    logger.info('Geodesic: ~/.geodesic-creds.env not found or incomplete — skipping');
    return null;
  }
  return new GeodesicChannel(opts, creds);
});
