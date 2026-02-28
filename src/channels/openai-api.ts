/**
 * OpenAI-Compatible HTTP API Channel
 *
 * Exposes NanoClaw's agent pipeline as an OpenAI-compatible API so that:
 *   - Open WebUI can use Nova as a chat backend
 *   - Home Assistant / Alexa can POST voice commands to /api/alexa
 *
 * Endpoints:
 *   GET  /v1/models                  — model list (Open WebUI discovery)
 *   POST /v1/chat/completions        — chat, supports SSE streaming
 *   POST /api/alexa                  — simple JSON endpoint for HA/Alexa
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, HTTP_API_KEY, HTTP_PORT } from '../config.js';
import { ContainerOutput, runContainerAgent } from '../container-runner.js';
import { setSession } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { Channel, RegisteredGroup } from '../types.js';

export const WEBUI_JID = 'webui@nanoclaw.local';
export const WEBUI_GROUP_FOLDER = 'webui';

export interface OpenAIApiDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: {
    registerProcess: (
      jid: string,
      proc: import('child_process').ChildProcess,
      containerName: string,
      groupFolder: string,
    ) => void;
  };
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

export class OpenAIApiChannel implements Channel {
  name = 'openai-api';
  private server: http.Server;
  private deps: OpenAIApiDeps;
  private _connected = false;

  constructor(deps: OpenAIApiDeps) {
    this.deps = deps;
    this.server = http.createServer((req, res) =>
      this.handleRequest(req, res),
    );
  }

  async connect(): Promise<void> {
    // Auto-register the webui virtual group if it doesn't exist yet
    const groups = this.deps.registeredGroups();
    if (!groups[WEBUI_JID]) {
      this.deps.registerGroup(WEBUI_JID, {
        name: 'Open WebUI',
        folder: WEBUI_GROUP_FOLDER,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });
    }

    // Seed a CLAUDE.md for the webui group (markdown is fine here, unlike WhatsApp)
    const groupDir = resolveGroupFolderPath(WEBUI_GROUP_FOLDER);
    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMd)) {
      fs.writeFileSync(
        claudeMd,
        `# ${ASSISTANT_NAME} — Web Interface\n\nYou are ${ASSISTANT_NAME}, a personal assistant. The user is talking to you via the Open WebUI browser interface.\n\n## Formatting\n\nMarkdown IS supported here. Use headings, bold, code blocks, and lists freely — unlike the WhatsApp channel.\n\n## Alexa Commands\n\nMessages prefixed with \`[Alexa voice command]\` come from the user's Alexa device via Home Assistant. Keep responses concise (they may be read aloud or sent to WhatsApp).\n`,
        'utf-8',
      );
    }

    return new Promise((resolve, reject) => {
      this.server.listen(HTTP_PORT, () => {
        this._connected = true;
        logger.info({ port: HTTP_PORT }, 'OpenAI API channel listening');
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        this._connected = false;
        resolve();
      });
    });
  }

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    return jid === WEBUI_JID;
  }

  // The HTTP channel is request-response: outbound messages are returned
  // inline in the HTTP response. This no-op satisfies the Channel interface
  // for the rare case where the scheduler sends a message to this group.
  async sendMessage(_jid: string, _text: string): Promise<void> {}

  // ── Request routing ───────────────────────────────────────────────────────

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`);

    if (!this.checkAuth(req)) {
      this.sendJson(res, 401, {
        error: { message: 'Unauthorized', type: 'invalid_request_error' },
      });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(200, this.corsHeaders());
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      this.handleModels(res);
    } else if (
      req.method === 'POST' &&
      url.pathname === '/v1/chat/completions'
    ) {
      this.handleChatCompletions(req, res).catch((err) => {
        logger.error({ err }, 'Chat completions handler error');
        if (!res.headersSent) {
          this.sendJson(res, 500, {
            error: { message: 'Internal server error', type: 'server_error' },
          });
        }
      });
    } else if (req.method === 'POST' && url.pathname === '/api/alexa') {
      this.handleAlexa(req, res).catch((err) => {
        logger.error({ err }, 'Alexa handler error');
        if (!res.headersSent) {
          this.sendJson(res, 500, { error: 'Internal server error' });
        }
      });
    } else {
      this.sendJson(res, 404, {
        error: { message: 'Not found', type: 'invalid_request_error' },
      });
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private checkAuth(req: http.IncomingMessage): boolean {
    if (!HTTP_API_KEY) return true;
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    return token === HTTP_API_KEY;
  }

  // ── GET /v1/models ────────────────────────────────────────────────────────

  private handleModels(res: http.ServerResponse): void {
    this.sendJson(res, 200, {
      object: 'list',
      data: [
        {
          id: ASSISTANT_NAME.toLowerCase(),
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'nanoclaw',
        },
      ],
    });
  }

  // ── POST /v1/chat/completions ─────────────────────────────────────────────

  private async handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const raw = await this.readBody(req);
    let body: {
      messages?: Array<{ role: string; content: string }>;
      stream?: boolean;
      chat_id?: string;
    };
    try {
      body = JSON.parse(raw);
    } catch {
      this.sendJson(res, 400, {
        error: { message: 'Invalid JSON', type: 'invalid_request_error' },
      });
      return;
    }

    const messages = body.messages || [];
    const stream = body.stream === true;

    const sessionKey = body.chat_id
      ? `webui:${body.chat_id}`
      : WEBUI_GROUP_FOLDER;

    if (body.chat_id) {
      logger.debug({ chat_id: body.chat_id, sessionKey }, 'OpenAI API: per-conversation session');
    }

    // Use the last user message as the prompt. NanoClaw's container session
    // already maintains conversation history — we don't need to replay the
    // full Open WebUI history.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) {
      this.sendJson(res, 400, {
        error: {
          message: 'No user message in request',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const group = this.getWebuiGroup();
    if (!group) {
      this.sendJson(res, 503, {
        error: { message: 'WebUI group not ready', type: 'server_error' },
      });
      return;
    }

    const completionId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const modelId = ASSISTANT_NAME.toLowerCase();

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...this.corsHeaders(),
      });

      await this.runForGroup(group, lastUser.content, sessionKey, async (output) => {
        if (output.result) {
          const text = this.stripInternal(output.result);
          if (text) {
            this.sendSseChunk(res, completionId, created, modelId, text);
          }
        }
      });

      // Final chunk with finish_reason=stop
      res.write(
        `data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      let fullText = '';
      await this.runForGroup(group, lastUser.content, sessionKey, async (output) => {
        if (output.result) {
          const text = this.stripInternal(output.result);
          if (text) fullText += (fullText ? '\n\n' : '') + text;
        }
      });

      this.sendJson(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: fullText },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  }

  // ── POST /api/alexa ───────────────────────────────────────────────────────

  private async handleAlexa(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const raw = await this.readBody(req);
    let body: { message?: string; text?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      this.sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const message = body.message || body.text || '';
    if (!message) {
      this.sendJson(res, 400, { error: 'Missing message or text field' });
      return;
    }

    const group = this.getWebuiGroup();
    if (!group) {
      this.sendJson(res, 503, { error: 'WebUI group not ready' });
      return;
    }

    let responseText = '';
    await this.runForGroup(
      group,
      `[Alexa voice command] ${message}`,
      WEBUI_GROUP_FOLDER,
      async (output) => {
        if (output.result) {
          const text = this.stripInternal(output.result);
          if (text) responseText += (responseText ? '\n' : '') + text;
        }
      },
    );

    this.sendJson(res, 200, { response: responseText });
  }

  // ── Agent execution ───────────────────────────────────────────────────────

  private async runForGroup(
    group: RegisteredGroup,
    prompt: string,
    sessionKey: string,
    onOutput: (output: ContainerOutput) => Promise<void>,
  ): Promise<void> {
    const sessions = this.deps.getSessions();
    const sessionId = sessions[sessionKey];

    try {
      const result = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid: WEBUI_JID,
          isMain: false,
          assistantName: ASSISTANT_NAME,
        },
        (proc, containerName) => {
          this.deps.queue.registerProcess(
            WEBUI_JID,
            proc,
            containerName,
            group.folder,
          );
        },
        async (output) => {
          if (output.newSessionId) {
            sessions[sessionKey] = output.newSessionId;
            setSession(sessionKey, output.newSessionId);
          }
          await onOutput(output);
        },
      );

      if (result.newSessionId) {
        sessions[sessionKey] = result.newSessionId;
        setSession(sessionKey, result.newSessionId);
      }
    } catch (err) {
      logger.error({ err, group: group.name }, 'OpenAI API: agent error');
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private getWebuiGroup(): RegisteredGroup | undefined {
    return this.deps.registeredGroups()[WEBUI_JID];
  }

  private stripInternal(text: string): string {
    return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
  }

  private sendSseChunk(
    res: http.ServerResponse,
    id: string,
    created: number,
    model: string,
    content: string,
  ): void {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`,
    );
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
  ): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...this.corsHeaders(),
    });
    res.end(JSON.stringify(body));
  }

  private corsHeaders(): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }
}
