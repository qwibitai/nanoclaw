import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { MONITOR_PORT } from './config.js';
import { getAllTasks, getRecentMessages, getTaskRunLogs } from './db.js';
import { logger } from './logger.js';
import { monitorBus } from './monitor-events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve dashboard HTML — works from both src/ (dev) and dist/ (compiled)
// Try enhanced dashboard first, fallback to basic dashboard
const DASHBOARD_PATH = fs.existsSync(path.join(__dirname, 'monitoring', 'dashboard-enhanced.html'))
  ? path.join(__dirname, 'monitoring', 'dashboard-enhanced.html')
  : fs.existsSync(path.join(__dirname, '..', 'src', 'monitoring', 'dashboard-enhanced.html'))
  ? path.join(__dirname, '..', 'src', 'monitoring', 'dashboard-enhanced.html')
  : fs.existsSync(path.join(__dirname, 'monitoring', 'dashboard.html'))
  ? path.join(__dirname, 'monitoring', 'dashboard.html')
  : path.join(__dirname, '..', 'src', 'monitoring', 'dashboard.html');

const startTime = Date.now();

export interface MonitorDeps {
  getGroups: () => Array<{
    jid: string;
    name: string;
    folder: string;
    isRegistered: boolean;
    lastActivity?: string;
  }>;
  getQueueState: () => {
    activeCount: number;
    maxConcurrent: number;
    waitingCount: number;
    groups: Array<{
      jid: string;
      active: boolean;
      pendingMessages: boolean;
      pendingTasks: number;
      containerName: string | null;
    }>;
  };
  getChannelStatus: () => Array<{ name: string; connected: boolean }>;
}

let dashboardHtml: string | null = null;

function loadDashboardHtml(): string {
  if (dashboardHtml) return dashboardHtml;
  dashboardHtml = fs.readFileSync(DASHBOARD_PATH, 'utf-8');
  return dashboardHtml;
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  for (const part of url.slice(idx + 1).split('&')) {
    const [k, v] = part.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return params;
}

export function startMonitorServer(deps: MonitorDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];

    if (pathname === '/') {
      try {
        const html = loadDashboardHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to load dashboard');
      }
      return;
    }

    if (pathname === '/api/status') {
      const queueState = deps.getQueueState();
      const channels = deps.getChannelStatus();
      const mem = process.memoryUsage();
      json(res, {
        uptime: Date.now() - startTime,
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
        },
        nodeVersion: process.version,
        activeContainers: queueState.activeCount,
        maxContainers: queueState.maxConcurrent,
        waitingCount: queueState.waitingCount,
        channels,
      });
      return;
    }

    if (pathname === '/api/groups') {
      const groups = deps.getGroups();
      const queueState = deps.getQueueState();
      const queueByJid = new Map(queueState.groups.map((g) => [g.jid, g]));

      const result = groups.map((g) => {
        const q = queueByJid.get(g.jid);
        return {
          ...g,
          active: q?.active || false,
          pendingMessages: q?.pendingMessages || false,
          pendingTasks: q?.pendingTasks || 0,
          containerName: q?.containerName || null,
        };
      });
      json(res, result);
      return;
    }

    if (pathname === '/api/tasks') {
      const tasks = getAllTasks();
      json(res, tasks);
      return;
    }

    if (pathname === '/api/task-logs') {
      const query = parseQuery(url);
      const taskId = query.taskId || undefined;
      const limit = parseInt(query.limit || '50', 10);
      const logs = getTaskRunLogs(taskId, limit);
      json(res, logs);
      return;
    }

    if (pathname === '/api/messages') {
      const query = parseQuery(url);
      const jid = query.jid || undefined;
      const limit = parseInt(query.limit || '50', 10);
      const messages = getRecentMessages(jid, limit);
      json(res, messages);
      return;
    }

    // Trading API endpoints
    if (pathname === '/api/trading/positions') {
      const query = parseQuery(url);
      const status = query.status || undefined;
      const limit = parseInt(query.limit || '50', 10);

      try {
        const Database = (await import('better-sqlite3')).default;
        const dbPath = path.join(process.env.STORE_DIR || 'store', 'messages.db');
        const db = new Database(dbPath);

        let sql = `SELECT * FROM trading_positions`;
        const params: any[] = [];

        if (status) {
          sql += ` WHERE status = ?`;
          params.push(status);
        }

        sql += ` ORDER BY entry_date DESC LIMIT ?`;
        params.push(Math.min(Math.max(1, limit), 200));

        const positions = db.prepare(sql).all(...params);
        db.close();
        json(res, positions);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/performance') {
      const query = parseQuery(url);
      const days = parseInt(query.days || '30', 10);

      try {
        const Database = (await import('better-sqlite3')).default;
        const dbPath = path.join(process.env.STORE_DIR || 'store', 'messages.db');
        const db = new Database(dbPath);

        const metrics = db
          .prepare(`SELECT * FROM performance_metrics ORDER BY date DESC LIMIT ?`)
          .all(days);

        const recentPositions = db
          .prepare(
            `SELECT * FROM trading_positions WHERE status = 'closed' ORDER BY exit_date DESC LIMIT 10`,
          )
          .all();

        db.close();
        json(res, { metrics, recent_trades: recentPositions });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/signals') {
      const query = parseQuery(url);
      const limit = parseInt(query.limit || '20', 10);

      try {
        const Database = (await import('better-sqlite3')).default;
        const dbPath = path.join(process.env.STORE_DIR || 'store', 'messages.db');
        const db = new Database(dbPath);

        const signals = db
          .prepare(`SELECT * FROM strategy_state ORDER BY timestamp DESC LIMIT ?`)
          .all(Math.min(Math.max(1, limit), 100));

        db.close();
        json(res, signals);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Heartbeat
      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 30000);

      const listener = (eventName: string) => (payload: unknown) => {
        send(eventName, payload);
      };

      const listeners = new Map<string, (payload: unknown) => void>();
      for (const eventName of Object.values(
        // Import MONITOR_EVENTS inline to get names
        {
          CONTAINER_START: 'container:start',
          CONTAINER_END: 'container:end',
          MESSAGE_RECEIVED: 'message:received',
          MESSAGE_SENT: 'message:sent',
          QUEUE_CHANGE: 'queue:change',
          TASK_STARTED: 'task:started',
          TASK_COMPLETED: 'task:completed',
          CHANNEL_STATUS: 'channel:status',
        },
      )) {
        const fn = listener(eventName);
        listeners.set(eventName, fn);
        monitorBus.on(eventName, fn);
      }

      req.on('close', () => {
        clearInterval(heartbeat);
        for (const [eventName, fn] of listeners) {
          monitorBus.off(eventName, fn);
        }
      });
      return;
    }

    // Restart endpoint
    if (pathname === '/api/restart' && req.method === 'POST') {
      json(res, { status: 'restarting' });

      // Delay restart to allow response to be sent
      setTimeout(() => {
        logger.info('Monitor dashboard triggered restart');
        process.exit(0); // PM2/systemd will auto-restart
      }, 500);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(MONITOR_PORT, '0.0.0.0', () => {
    const hostname = process.env.MONITOR_HOSTNAME || os.hostname().toLowerCase();
    logger.info(`Monitor dashboard listening on http://${hostname}:${MONITOR_PORT}`);
  });

  return server;
}
