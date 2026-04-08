/**
 * Vite plugin that serves dummy /dashboard/api/* responses from
 * dev-fixtures/ JSON files during `vite preview`.
 *
 * Activated by setting `DASHBOARD_FIXTURES=1` in the environment
 * before running `vite preview` (or `vite dev`). When the flag is
 * unset, the plugin is a no-op so production builds are unaffected.
 *
 * The fixture set is intentionally fake — see the JSON files for
 * detail. It exists so screenshots and video walkthroughs can run
 * against vite preview without needing nanoclaw deployed and a real
 * sigma-data tree behind it.
 *
 * Routes served (mirrors nanoclaw/src/channels/dashboard-api.ts):
 *   GET /dashboard/api/graph     → dev-fixtures/graph.json
 *   GET /dashboard/api/devtasks  → dev-fixtures/devtasks.json
 *   GET /dashboard/api/tasks     → dev-fixtures/tasks.json
 *   GET /dashboard/api/reports   → dev-fixtures/reports.json
 *   GET /dashboard/api/reports/<id> → dev-fixtures/reports/<id>.json
 *   GET /dashboard/api/meals     → dev-fixtures/meals.json
 *   GET /dashboard/events        → SSE stub (sends "connected" then idles)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer, PreviewServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));

function isEnabled(): boolean {
  return process.env.DASHBOARD_FIXTURES === "1";
}

function readJsonFixture(relPath: string): string | null {
  const full = path.join(FIXTURES_DIR, relPath);
  // Resolve + containment check so any URL-derived path can never
  // escape the fixtures dir even if the route matching has a bug.
  const resolved = path.resolve(full);
  if (!resolved.startsWith(FIXTURES_DIR + path.sep)) return null;
  try {
    return fs.readFileSync(resolved, "utf-8");
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

function sendNotFound(res: ServerResponse, msg: string): void {
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: msg }));
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  // The env-var gate is checked here on every request rather than
  // at plugin-registration time so flipping the flag doesn't require
  // a vite config reload. When the flag is unset the middleware is
  // a pure pass-through.
  if (!isEnabled() || req.method !== "GET" || !req.url) {
    next();
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  // SSE stub. Sends an initial "connected" message and then idles.
  // Real invalidations come from the actual nanoclaw server in
  // production; for fixture mode the bridge just needs to connect
  // without throwing.
  if (pathname === "/dashboard/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write('data: "connected"\n\n');
    // Keep the connection open. Don't end() — that would trigger
    // the client's onerror reconnect loop.
    return;
  }

  // Static endpoints.
  const staticMap: Record<string, string> = {
    "/dashboard/api/graph": "graph.json",
    "/dashboard/api/devtasks": "devtasks.json",
    "/dashboard/api/tasks": "tasks.json",
    "/dashboard/api/reports": "reports.json",
    "/dashboard/api/meals": "meals.json",
  };

  if (pathname in staticMap) {
    const body = readJsonFixture(staticMap[pathname]);
    if (body === null) {
      sendNotFound(res, `fixture missing: ${staticMap[pathname]}`);
      return;
    }
    sendJson(res, body);
    return;
  }

  // Per-id report detail.
  if (pathname.startsWith("/dashboard/api/reports/")) {
    const id = pathname.slice("/dashboard/api/reports/".length);
    // Tight allowlist on the id segment to keep the fixture loader
    // safe — only what real Pip-emitted ids look like.
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      sendNotFound(res, "invalid report id");
      return;
    }
    const body = readJsonFixture(`reports/${id}.json`);
    if (body === null) {
      sendNotFound(res, `report not found: ${id}`);
      return;
    }
    sendJson(res, body);
    return;
  }

  // Anything else falls through to vite's default handlers.
  next();
}

export function dashboardFixturesPlugin(): Plugin {
  return {
    name: "dashboard-fixtures",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(handleRequest);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(handleRequest);
    },
  };
}
