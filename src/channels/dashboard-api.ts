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

const PICKLE_GROUP = 'telegram_pickle';
const PLAN_FILE = path.join(GROUPS_DIR, PICKLE_GROUP, 'current-plan.md');
const INGREDIENTS_FILE = path.join(GROUPS_DIR, PICKLE_GROUP, 'ingredients.md');

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

  if (!url.startsWith('/dashboard/api/')) return false;

  // Vault graph
  if (url === '/dashboard/api/graph') {
    readVaultGraph()
      .then((graph) => jsonResponse(res, graph))
      .catch((err) =>
        jsonResponse(res, { error: 'Failed to read vault: ' + err.message }, 500),
      );
    return true;
  }

  // Dev tasks
  if (url === '/dashboard/api/devtasks') {
    try {
      const tasks = listDevTasks();
      jsonResponse(res, { tasks });
    } catch (err: any) {
      jsonResponse(res, { error: 'Failed to read dev tasks: ' + err.message }, 500);
    }
    return true;
  }

  // Scheduled tasks
  if (url === '/dashboard/api/tasks') {
    try {
      const tasks = getAllScheduledTasks();
      jsonResponse(res, { tasks });
    } catch (err: any) {
      jsonResponse(res, { error: 'Failed to read scheduled tasks: ' + err.message }, 500);
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
