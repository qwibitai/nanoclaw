import fs from 'fs';
import http, { IncomingMessage, ServerResponse } from 'http';
import path from 'path';

import { CanvasEventError, CanvasStore } from './canvas-store.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

interface GroupEntry {
  jid: string;
  name: string;
  folder: string;
}

export interface CanvasServerDeps {
  canvasStore: CanvasStore;
  registeredGroups: () => Record<string, RegisteredGroup>;
  port: number;
  uiDir?: string;
}

export class CanvasServer {
  private readonly canvasStore: CanvasStore;
  private readonly registeredGroups: () => Record<string, RegisteredGroup>;
  private readonly port: number;
  private readonly host = '127.0.0.1';
  private readonly uiDir: string;
  private server: http.Server | null = null;

  constructor(deps: CanvasServerDeps) {
    this.canvasStore = deps.canvasStore;
    this.registeredGroups = deps.registeredGroups;
    this.port = deps.port;
    this.uiDir = deps.uiDir || path.join(process.cwd(), 'web', 'dist');
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'Unhandled canvas server error');
        this.sendJson(res, 500, { error: 'Internal server error' });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => resolve());
    });

    logger.info({ host: this.host, port: this.port }, 'Canvas server started');
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    const serverToClose = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      serverToClose.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    logger.info('Canvas server stopped');
  }

  getPort(): number | null {
    if (!this.server) return null;
    const address = this.server.address();
    if (!address || typeof address === 'string') return null;
    return address.port;
  }

  canvasUrl(): string {
    const port = this.getPort() ?? this.port;
    return `http://${this.host}:${port}/canvas`;
  }

  applyEvents(groupFolder: string, eventsJsonl: string): {
    group: GroupEntry;
    state: ReturnType<CanvasStore['getState']>;
    canvasUrl: string;
  } {
    const group = this.findGroupByFolder(groupFolder);
    if (!group) {
      throw new CanvasEventError(`Unknown group folder: ${groupFolder}`, 0);
    }
    const state = this.canvasStore.applyEventsFromJsonl(groupFolder, eventsJsonl);
    return {
      group,
      state,
      canvasUrl: this.canvasUrl(),
    };
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (
      method === 'GET' &&
      (pathname === '/canvas' || pathname === '/canvas/')
    ) {
      this.serveStaticFile('index.html', 'text/html; charset=utf-8', res);
      return;
    }

    if (method === 'GET' && pathname.startsWith('/canvas/')) {
      const relative = pathname.slice('/canvas/'.length);
      if (!relative || relative.includes('..')) {
        this.sendJson(res, 400, { error: 'Invalid path' });
        return;
      }

      const extension = path.extname(relative);
      const contentType =
        extension === '.js'
          ? 'application/javascript; charset=utf-8'
          : extension === '.css'
            ? 'text/css; charset=utf-8'
            : extension === '.html'
              ? 'text/html; charset=utf-8'
              : 'application/octet-stream';

      this.serveStaticFile(relative, contentType, res);
      return;
    }

    if (method === 'GET' && pathname === '/api/canvas/groups') {
      this.sendJson(res, 200, {
        groups: this.getGroups(),
      });
      return;
    }

    const stateMatch = pathname.match(/^\/api\/canvas\/([^/]+)\/state$/);
    if (method === 'GET' && stateMatch) {
      const groupFolder = stateMatch[1];
      const group = this.findGroupByFolder(groupFolder);
      if (!group) {
        this.sendJson(res, 404, {
          error: `Unknown group folder: ${groupFolder}`,
        });
        return;
      }

      const state = this.canvasStore.getState(groupFolder);
      this.sendJson(res, 200, {
        group,
        ...state,
        canvasUrl: this.canvasUrl(),
      });
      return;
    }

    const eventsMatch = pathname.match(/^\/api\/canvas\/([^/]+)\/events$/);
    if (method === 'POST' && eventsMatch) {
      const groupFolder = eventsMatch[1];
      const group = this.findGroupByFolder(groupFolder);
      if (!group) {
        this.sendJson(res, 404, {
          error: `Unknown group folder: ${groupFolder}`,
        });
        return;
      }

      const body = await this.readBody(req);
      try {
        const state = this.canvasStore.applyEventsFromJsonl(groupFolder, body);
        this.sendJson(res, 200, {
          group,
          ...state,
          canvasUrl: this.canvasUrl(),
        });
      } catch (err) {
        if (err instanceof CanvasEventError) {
          this.sendJson(res, 400, {
            error: err.message,
            line: err.line,
          });
          return;
        }

        throw err;
      }
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  private getGroups(): GroupEntry[] {
    const groups = Object.entries(this.registeredGroups()).map(
      ([jid, group]) => ({
        jid,
        name: group.name,
        folder: group.folder,
      }),
    );

    groups.sort((a, b) => a.name.localeCompare(b.name));
    return groups;
  }

  private findGroupByFolder(groupFolder: string): GroupEntry | undefined {
    return this.getGroups().find((group) => group.folder === groupFolder);
  }

  private serveStaticFile(
    relativePath: string,
    contentType: string,
    res: ServerResponse,
  ): void {
    const filePath = path.join(this.uiDir, relativePath);
    if (!fs.existsSync(filePath)) {
      this.sendJson(res, 503, {
        error: `Canvas UI not built. Missing file: ${relativePath}`,
      });
      return;
    }

    const content = fs.readFileSync(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.end(content);
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;

      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 1_000_000) {
          reject(new Error('Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  private sendJson(
    res: ServerResponse,
    statusCode: number,
    payload: unknown,
  ): void {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  }
}
