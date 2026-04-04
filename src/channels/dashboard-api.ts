/**
 * Dashboard API — unauthenticated read-only JSON endpoints.
 * No auth — Tailscale is the access layer (same as meal plan page).
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../config.js';
import { readVaultGraph } from './vault-reader.js';
import { listTasks as listDevTasks } from '../dev-tasks.js';
import { getAllTasks as getAllScheduledTasks } from '../db.js';
import { parsePlan, parseIngredients } from './meal-plan-page.js';
import {
  onDevTasksChanged,
  onScheduledTasksChanged,
} from './ios-data-api.js';

const PICKLE_GROUP = 'telegram_pickle';
const PLAN_FILE = path.join(GROUPS_DIR, PICKLE_GROUP, 'current-plan.md');
const INGREDIENTS_FILE = path.join(GROUPS_DIR, PICKLE_GROUP, 'ingredients.md');

// --- SSE infrastructure ---

const sseClients = new Set<http.ServerResponse>();
let watchersStarted = false;

function sendSSEEvent(type: string): void {
  const data = `data: ${JSON.stringify({ type })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

function startDashboardWatchers(): void {
  if (watchersStarted) return;
  watchersStarted = true;

  // Subscribe to shared broadcast callbacks (dev tasks, scheduled tasks)
  onDevTasksChanged(() => sendSSEEvent('devtasks_updated'));
  onScheduledTasksChanged(() => sendSSEEvent('tasks_updated'));

  // Meal plan file watchers (separate from meal-plan-page.ts's own watchers)
  let mealDebounce: ReturnType<typeof setTimeout> | null = null;
  const notifyMeals = () => {
    if (mealDebounce) clearTimeout(mealDebounce);
    mealDebounce = setTimeout(() => sendSSEEvent('meals_updated'), 300);
  };
  for (const file of [PLAN_FILE, INGREDIENTS_FILE]) {
    try {
      fs.watch(file, notifyMeals);
    } catch {
      try {
        fs.watch(path.dirname(file), (_, filename) => {
          if (filename === path.basename(file)) notifyMeals();
        });
      } catch {
        // ignore
      }
    }
  }

  // Vault directory watcher
  const vaultPath = process.env.VAULT_PATH || '/Users/fambot/sigma-data/family-vault';
  let vaultDebounce: ReturnType<typeof setTimeout> | null = null;
  try {
    fs.watch(vaultPath, { recursive: true }, () => {
      if (vaultDebounce) clearTimeout(vaultDebounce);
      vaultDebounce = setTimeout(() => sendSSEEvent('vault_updated'), 500);
    });
  } catch {
    // Vault dir might not exist in dev environments
  }
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function jsonResponse(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Handle GET /dashboard/api/* routes. Returns true if matched. */
export function handleDashboardApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (req.method !== 'GET') return false;

  const url = req.url?.split('?')[0] || '';

  // SSE endpoint (before /dashboard/api/ prefix check)
  if (url === '/dashboard/events') {
    startDashboardWatchers();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: "connected"\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return true;
  }

  if (!url.startsWith('/dashboard/api/')) return false;

  // Vault graph
  if (url === '/dashboard/api/graph') {
    readVaultGraph()
      .then((graph) => jsonResponse(res, graph))
      .catch((err) =>
        jsonResponse(
          res,
          { error: 'Failed to read vault: ' + err.message },
          500,
        ),
      );
    return true;
  }

  // Dev tasks
  if (url === '/dashboard/api/devtasks') {
    try {
      const tasks = listDevTasks();
      jsonResponse(res, { tasks });
    } catch (err: any) {
      jsonResponse(
        res,
        { error: 'Failed to read dev tasks: ' + err.message },
        500,
      );
    }
    return true;
  }

  // Scheduled tasks
  if (url === '/dashboard/api/tasks') {
    try {
      const tasks = getAllScheduledTasks();
      jsonResponse(res, { tasks });
    } catch (err: any) {
      jsonResponse(
        res,
        { error: 'Failed to read scheduled tasks: ' + err.message },
        500,
      );
    }
    return true;
  }

  // Meal plan
  if (url === '/dashboard/api/meals') {
    const planMd = readFileSafe(PLAN_FILE);
    const ingredientsMd = readFileSafe(INGREDIENTS_FILE);
    const plan = planMd ? parsePlan(planMd) : null;
    const ingredients = ingredientsMd ? parseIngredients(ingredientsMd) : null;
    jsonResponse(res, { plan, ingredients });
    return true;
  }

  return false;
}
