import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { listReadyIssuesForProject } from './symphony-linear.js';
import { loadProjectRegistryFromFile } from './symphony-registry.js';
import {
  buildRuntimeState,
  listRunRecords,
  readRunRecord,
  readRuntimeState,
} from './symphony-state.js';

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function loadDashboardSnapshot(registryPath: string) {
  const registry = loadProjectRegistryFromFile(registryPath);
  const runtimeState =
    readRuntimeState() ||
    buildRuntimeState({
      registry,
      readyCounts: Object.fromEntries(
        registry.projects.map((project) => [project.projectKey, 0]),
      ),
      daemonHealthy: false,
    });
  const runs = listRunRecords();
  return { registry, runtimeState, runs };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function pageLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="5" />
  <title>${htmlEscape(title)}</title>
  <style>
    body { font-family: sans-serif; margin: 24px; background: #0b1020; color: #e8edf7; }
    a { color: #8ec5ff; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
    th, td { border: 1px solid #243252; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #13203d; }
    code, pre { background: #111827; padding: 2px 4px; border-radius: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { border: 1px solid #243252; border-radius: 8px; padding: 12px; background: #10192f; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderHome(snapshot: Awaited<ReturnType<typeof loadDashboardSnapshot>>): string {
  const state = snapshot.runtimeState;
  const projectRows = state.projects
    .map(
      (project) => `<tr>
<td><a href="/projects/${encodeURIComponent(project.projectKey)}">${htmlEscape(project.displayName)}</a></td>
<td>${project.symphonyEnabled ? 'enabled' : 'disabled'}</td>
<td>${project.readyQueueCount}</td>
<td>${project.activeRunCount}</td>
<td>${htmlEscape(project.lastRunStatus)}</td>
</tr>`,
    )
    .join('');

  const runRows = snapshot.runs
    .slice(0, 20)
    .map(
      (run) => `<tr>
<td><a href="/runs/${encodeURIComponent(run.runId)}">${htmlEscape(run.runId)}</a></td>
<td>${htmlEscape(run.projectKey)}</td>
<td>${htmlEscape(run.issueIdentifier)}</td>
<td>${htmlEscape(run.backend)}</td>
<td>${htmlEscape(run.status)}</td>
<td>${htmlEscape(run.startedAt)}</td>
</tr>`,
    )
    .join('');

  return pageLayout(
    'Symphony Dashboard',
    `
<h1>Symphony Dashboard</h1>
<div class="grid">
  <div class="card"><strong>Projects</strong><br/>${state.registryProjectCount}</div>
  <div class="card"><strong>Enabled</strong><br/>${state.enabledProjectCount}</div>
  <div class="card"><strong>Active Runs</strong><br/>${state.activeRunIds.length}</div>
  <div class="card"><strong>Daemon</strong><br/>${state.daemonHealthy ? 'healthy' : 'not running'}</div>
</div>
<h2>Projects</h2>
<table>
  <thead><tr><th>Project</th><th>Symphony</th><th>Ready</th><th>Active Runs</th><th>Last Run</th></tr></thead>
  <tbody>${projectRows}</tbody>
</table>
<h2>Recent Runs</h2>
<table>
  <thead><tr><th>Run</th><th>Project</th><th>Issue</th><th>Backend</th><th>Status</th><th>Started</th></tr></thead>
  <tbody>${runRows}</tbody>
</table>
<p><a href="/projects">Projects JSON View</a> | <a href="/runs">Runs</a> | <a href="/api/v1/state">API</a></p>
`,
  );
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  registryPath: string,
): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const snapshot = await loadDashboardSnapshot(registryPath);

  if (url.pathname === '/api/v1/state') {
    sendJson(res, 200, snapshot.runtimeState);
    return true;
  }

  if (url.pathname === '/api/v1/projects') {
    sendJson(
      res,
      200,
      snapshot.registry.projects.map((project) => ({
        ...project,
        summary: snapshot.runtimeState.projects.find(
          (summary) => summary.projectKey === project.projectKey,
        ),
      })),
    );
    return true;
  }

  const projectMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (projectMatch) {
    const projectKey = decodeURIComponent(projectMatch[1] || '');
    const project = snapshot.registry.projects.find((entry) => entry.projectKey === projectKey);
    if (!project) {
      sendJson(res, 404, { error: `Unknown project ${projectKey}` });
      return true;
    }
    const readyIssues = await listReadyIssuesForProject(project);
    sendJson(res, 200, {
      project,
      summary: snapshot.runtimeState.projects.find((summary) => summary.projectKey === projectKey),
      readyIssues,
      runs: snapshot.runs.filter((run) => run.projectKey === projectKey),
    });
    return true;
  }

  if (url.pathname === '/api/v1/runs') {
    sendJson(res, 200, snapshot.runs);
    return true;
  }

  const runMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1] || '');
    try {
      sendJson(res, 200, readRunRecord(runId));
    } catch {
      sendJson(res, 404, { error: `Unknown run ${runId}` });
    }
    return true;
  }

  return false;
}

async function handleHtml(
  req: IncomingMessage,
  res: ServerResponse,
  registryPath: string,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const snapshot = await loadDashboardSnapshot(registryPath);

  if (url.pathname === '/' || url.pathname === '/projects') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderHome(snapshot));
    return;
  }

  const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    const projectKey = decodeURIComponent(projectMatch[1] || '');
    const project = snapshot.registry.projects.find((entry) => entry.projectKey === projectKey);
    if (!project) {
      res.statusCode = 404;
      res.end('Unknown project');
      return;
    }
    const readyIssues = await listReadyIssuesForProject(project);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      pageLayout(
        `Project ${project.displayName}`,
        `
<h1>${htmlEscape(project.displayName)}</h1>
<p><a href="/">Back</a></p>
<p>GitHub: ${htmlEscape(project.githubRepo)}<br/>Notion: <a href="${htmlEscape(project.notionRoot)}">${htmlEscape(project.notionRoot)}</a></p>
<h2>Ready Issues</h2>
<pre>${htmlEscape(JSON.stringify(readyIssues, null, 2))}</pre>
<h2>Recent Runs</h2>
<pre>${htmlEscape(JSON.stringify(snapshot.runs.filter((run) => run.projectKey === projectKey), null, 2))}</pre>
`,
      ),
    );
    return;
  }

  if (url.pathname === '/runs') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      pageLayout(
        'Runs',
        `<h1>Runs</h1><p><a href="/">Back</a></p><pre>${htmlEscape(
          JSON.stringify(snapshot.runs, null, 2),
        )}</pre>`,
      ),
    );
    return;
  }

  const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1] || '');
    try {
      const run = readRunRecord(runId);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        pageLayout(
          `Run ${runId}`,
          `<h1>${htmlEscape(runId)}</h1><p><a href="/">Back</a></p><pre>${htmlEscape(
            JSON.stringify(run, null, 2),
          )}</pre>`,
        ),
      );
      return;
    } catch {
      res.statusCode = 404;
      res.end('Unknown run');
      return;
    }
  }

  res.statusCode = 404;
  res.end('Not found');
}

export function startSymphonyServer(input: {
  port: number;
  registryPath: string;
}): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      if (await handleApi(req, res, input.registryPath)) {
        return;
      }
      await handleHtml(req, res, input.registryPath);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(input.port, '127.0.0.1', () => resolve(server));
  });
}
